import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { SimpleVault } from "../target/types/simple_vault";

describe("simple_vault — неделя 9", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const users = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const unit = new BN(10).pow(new BN(6));
  const initialBalance = unit.muln(1000);
  const tokenAccounts: PublicKey[] = [];
  const shareAccounts: PublicKey[] = [];
  const paidFees = [new BN(0), new BN(0), new BN(0)];
  let tokenMint: PublicKey;
  let feeWallet: PublicKey;
  let vaultState: PublicKey;
  let vaultTokenAccount: PublicKey;
  let shareMint: PublicKey;

  async function balance(account: PublicKey): Promise<BN> {
    return new BN((await getAccount(connection, account)).amount.toString());
  }

  function deposit(index: number, amount: BN, feeAccount = feeWallet) {
    return program.methods
      .deposit(amount)
      .accountsPartial({
        vaultState,
        vaultTokenAccount,
        shareMint,
        feeWallet: feeAccount,
        userTokenAccount: tokenAccounts[index],
        userShareAccount: shareAccounts[index],
        user: users[index].publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([users[index]])
      .rpc();
  }

  function withdraw(index: number, shares: BN) {
    return program.methods
      .withdraw(shares)
      .accountsPartial({
        vaultState,
        vaultTokenAccount,
        shareMint,
        userTokenAccount: tokenAccounts[index],
        userShareAccount: shareAccounts[index],
        user: users[index].publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([users[index]])
      .rpc();
  }

  function setPaused(isPaused: boolean, signer = admin) {
    return program.methods
      .setPaused(isPaused)
      .accountsPartial({ vaultState, admin: signer.publicKey })
      .signers([signer])
      .rpc();
  }

  async function snapshot() {
    const addresses = [vaultState, vaultTokenAccount, feeWallet, ...tokenAccounts, ...shareAccounts, shareMint];
    const accounts = await connection.getMultipleAccountsInfo(addresses);
    const vault = program.coder.accounts.decode("vaultState", accounts[0].data);
    const balances = addresses.slice(1, -1).map((address, index) =>
      unpackAccount(address, accounts[index + 1]).amount.toString()
    );
    return {
      tokens: vault.totalTokens.toString(),
      shares: vault.totalShares.toString(),
      paused: vault.isPaused,
      vaultBalance: balances[0],
      feeBalance: balances[1],
      userTokens: balances.slice(2, 2 + users.length),
      userShares: balances.slice(2 + users.length),
      supply: unpackMint(shareMint, accounts[accounts.length - 1]).supply.toString(),
    };
  }

  async function expectUnchangedError(action: () => Promise<unknown>, code: string | RegExp) {
    const before = await snapshot();
    try {
      await action();
      assert.fail(`Expected ${code}`);
    } catch (error) {
      if (typeof code === "string") {
        assert.equal(error.error?.errorCode?.code, code, String(error));
      } else {
        assert.match(String(error), code);
      }
    }
    assert.deepEqual(await snapshot(), before, "Отклонённая операция меняет баланс или state");
  }

  before(async () => {
    const funding = new Transaction();
    for (const user of users) {
      funding.add(SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: user.publicKey,
        lamports: 10_000_000,
      }));
    }
    await provider.sendAndConfirm(funding, [admin]);
    tokenMint = await createMint(connection, admin, admin.publicKey, null, 6);
    feeWallet = await createAccount(connection, admin, tokenMint, admin.publicKey);
    for (const user of users) {
      const account = await createAccount(connection, admin, tokenMint, user.publicKey);
      tokenAccounts.push(account);
      await mintTo(connection, admin, tokenMint, account, admin, BigInt(initialBalance.toString()));
    }
    [vaultState] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()], program.programId
    );
    [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()], program.programId
    );
    [shareMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()], program.programId
    );
  });

  it("initialize_vault: сохраняет администратора, fee_wallet и минимум в один токен", async () => {
    await program.methods.initializeVault().accountsPartial({
      vaultState,
      vaultTokenAccount,
      shareMint,
      tokenMint,
      feeWallet,
      admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    }).signers([admin]).rpc();

    const vault = await program.account.vaultState.fetch(vaultState);
    assert.equal(vault.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.feeWallet.toBase58(), feeWallet.toBase58());
    assert.equal(vault.minDeposit.toString(), unit.toString());
    assert.isFalse(vault.isPaused);
    assert.equal(vault.totalTokens.toString(), "0");
    assert.equal(vault.totalShares.toString(), "0");
    for (const user of users) {
      shareAccounts.push(await createAccount(connection, admin, shareMint, user.publicKey));
    }
  });

  it("deposit: отклоняет нулевую сумму и сумму меньше одного токена", async () => {
    await expectUnchangedError(() => deposit(0, new BN(0)), "ZeroAmount");
    await expectUnchangedError(() => deposit(0, unit.subn(1)), "DepositTooSmall");
  });

  it("deposit: запрещает подменить fee_wallet аккаунтом пользователя", async () => {
    await expectUnchangedError(() => deposit(0, unit, tokenAccounts[0]), "ConstraintAddress");
  });

  it("deposit: нехватка средств на комиссию откатывает перевод в vault", async () => {
    const amount = (await balance(tokenAccounts[0])).addn(1);
    await expectUnchangedError(() => deposit(0, amount), /custom program error: 0x1/);
  });

  it("deposit: три пользователя получают shares после комиссии 1%; минимум и округление работают", async () => {
    const deposits = [
      { index: 0, amount: unit.muln(100) },
      { index: 1, amount: unit.muln(50) },
      { index: 2, amount: unit.muln(25) },
      { index: 0, amount: unit },
      { index: 2, amount: unit.addn(99) },
    ];
    let totalNet = new BN(0);
    let totalFees = new BN(0);
    for (const { index, amount } of deposits) {
      const before = await snapshot();
      const fee = amount.divn(100);
      const net = amount.sub(fee);
      await deposit(index, amount);
      paidFees[index] = paidFees[index].add(fee);
      totalFees = totalFees.add(fee);
      totalNet = totalNet.add(net);
      const after = await snapshot();
      assert.equal(new BN(before.userTokens[index]).sub(new BN(after.userTokens[index])).toString(), amount.toString());
      assert.equal(new BN(after.userShares[index]).sub(new BN(before.userShares[index])).toString(), net.toString());
      assert.equal(after.tokens, totalNet.toString());
      assert.equal(after.shares, totalNet.toString());
      assert.equal(after.vaultBalance, totalNet.toString());
      assert.equal(after.feeBalance, totalFees.toString());
      assert.equal(after.supply, totalNet.toString());
    }
  });

  it("withdraw: отклоняет нулевой вывод и вывод больше собственных shares", async () => {
    await expectUnchangedError(() => withdraw(0, new BN(0)), "ZeroAmount");
    const excess = (await balance(shareAccounts[0])).addn(1);
    await expectUnchangedError(() => withdraw(0, excess), /custom program error: 0x1/);
  });

  it("set_paused: только администратор может остановить и возобновить депозиты", async () => {
    await expectUnchangedError(() => setPaused(true, users[0]), "Unauthorized");
    await setPaused(true);
    assert.isTrue((await program.account.vaultState.fetch(vaultState)).isPaused);
    await expectUnchangedError(() => setPaused(false, users[0]), "Unauthorized");
    await expectUnchangedError(() => deposit(1, unit), "VaultPaused");
  });

  it("withdraw: вывод доступен при паузе депозитов", async () => {
    const half = (await balance(shareAccounts[0])).divn(2);
    const before = await balance(tokenAccounts[0]);
    await withdraw(0, half);
    assert.equal((await balance(tokenAccounts[0])).sub(before).toString(), half.toString());
    assert.isTrue((await program.account.vaultState.fetch(vaultState)).isPaused);
  });

  it("set_paused: администратор возобновляет депозиты", async () => {
    await setPaused(false);
    assert.isFalse((await program.account.vaultState.fetch(vaultState)).isPaused);
    await deposit(1, unit);
    paidFees[1] = paidFees[1].add(unit.divn(100));
  });

  it("три пользователя выводят все shares: vault пуст, комиссии остаются на fee_wallet", async () => {
    const feesBefore = await balance(feeWallet);
    for (let index = 0; index < users.length; index++) {
      const shares = await balance(shareAccounts[index]);
      await withdraw(index, shares);
      const state = await snapshot();
      assert.equal(state.userShares[index], "0");
      assert.equal(state.userTokens[index], initialBalance.sub(paidFees[index]).toString());
      assert.equal(state.vaultBalance, state.tokens);
      assert.equal(state.supply, state.shares);
    }
    const state = await snapshot();
    assert.equal(state.tokens, "0");
    assert.equal(state.shares, "0");
    assert.equal(state.vaultBalance, "0");
    assert.equal(state.supply, "0");
    assert.equal(state.feeBalance, feesBefore.toString());
    assert.equal(feesBefore.toString(), paidFees.reduce((sum, fee) => sum.add(fee), new BN(0)).toString());
  });
});
