# Simple Vault — практика Anchor

Минимальный SPL-токен vault на Anchor 0.31.1.  
Базовые инструкции: `initialize_vault` → `deposit` → `withdraw`; `set_paused` управляет паузой депозитов.


## Проверка решения — 22.10.2026

- Сборка Solana-программы и IDL, `cargo test --lib --locked`, `npm run typecheck` — успешно.
- `npm test -- --skip-build` — 10 тестов на локальном валидаторе.
- `npm run test:devnet -- --skip-build` — 10 тестов в devnet.
- Развёрнутый байткод совпадает с локальным артефактом (432080 байт).

[Программа в devnet](https://explorer.solana.com/address/DTYAxMLXSQzFWm79VAHsSNF9Bitm34QkEwc2571nyBZS?cluster=devnet) ·
[Транзакция деплоя](https://explorer.solana.com/tx/31gKnDrM99rrEujrxtDAwseFeteRe8N7gSzNvDLhng9uYfPnTTWdhdbM9NN36kmE61mDziVsD621hb9oKedTvJJf?cluster=devnet)

IDL опубликован в аккаунте `8T6faaoLcVWRP7wRuYKcEfWiYDbwC5p2K7yUCZ45koYB`.
SHA-256 бинарника: `abbb590aa6565f700b0d0f85560a8d3571c74ee51bc8c7281f0dec7825741afa`.
Проверка охватывает задание 9-й недели; открытие и закрытие позиций Raydium отдельно не запускались.

---

## Что делает контракт

```
initialize_vault   создаёт VaultState PDA, vault token account, share mint; сохраняет fee_wallet
deposit(amount)    отправляет 1% на fee_wallet, остаток в vault → минтит shares
withdraw(shares)   сжигает shares → возвращает токены пользователю
set_paused(bool)  admin останавливает или возобновляет депозиты; вывод остаётся доступен
```

**Формула shares:**
```
Комиссия:             fee = floor(amount / 100)
Сумма в vault:        net_amount = amount - fee
Первый депозит:       shares = net_amount      (1:1 после комиссии)
Последующие:          shares = net_amount × total_shares / total_tokens
Вывод:                tokens = shares × total_tokens / total_shares
```

Минимальный депозит — **один целый токен до комиссии**: `10^decimals` минимальных единиц
(при `decimals = 6` это `1_000_000`). Комиссия округляется вниз до минимальной единицы токена.
При `decimals = 0` комиссия с депозитов меньше 100 токенов равна нулю.

`fee_wallet` — заранее созданный SPL-токен-аккаунт администратора для того же mint.
Он передаётся в `initializeVault().accountsPartial({ ..., feeWallet })`, сохраняется в state
и обязателен в каждом `deposit`. Подмена адреса отклоняется контрактом.

Пауза: `program.methods.setPaused(true)` / `setPaused(false)` с аккаунтами
`{ vaultState, admin }` и подписью администратора.

**Совместимость:** формат `VaultState` расширен. Для этой версии создайте vault с новым
тестовым mint; существующему vault старой версии нужна отдельная миграция.
Тесты каждый раз создают новый mint.

---

## Предварительные требования

| Инструмент | Версия | Установка |
|---|---|---|
| Rust | stable | https://rustup.rs |
| Solana CLI (Agave) | 4.2.2 | https://solana.com/docs/intro/installation |
| cargo-build-sbf | 4.4.0 (platform-tools v1.57) | `cargo install cargo-build-sbf --version 4.4.0 --locked` |
| Anchor CLI | 0.31.1 | `cargo install --git https://github.com/coral-xyz/anchor avm --locked && avm install 0.31.1 && avm use 0.31.1` |
| Node.js | 18+ | https://nodejs.org |

---

## Быстрый старт

### 1. Установить зависимости

```bash
cd vault-dev
npx --yes yarn@1.22.22 install --frozen-lockfile
```

Кошелёк проекта — `devnet-wallet.json` (исключён из Git и архива). Если файла ещё нет:

```bash
solana-keygen new --outfile devnet-wallet.json
```

Существующий кошелёк не пересоздавайте. Резервная копия ключа программы,
`simple-vault-program.keypair.json`, также исключена из Git.

### 2. Сбилдить контракт

```bash
anchor build
```

Артефакты появятся в `target/deploy/`:
- `simple_vault.so` — скомпилированная программа
- `simple_vault-keypair.json` — keypair программы

### 3. Получить Program ID

```bash
anchor keys list
# simple_vault: DTYAxMLXSQzFWm79VAHsSNF9Bitm34QkEwc2571nyBZS
```

Если создаёшь **с нуля** (новый keypair):
```bash
# после первого anchor build:
anchor keys sync --provider.cluster devnet
anchor keys sync --provider.cluster localnet
anchor build        # пересобрать с новым ID для обеих сетей
```

### 4. Проверить локально

```bash
npm test             # localnet: сборка, локальный валидатор, деплой и тесты
npm run typecheck    # после anchor build, когда создан target/types/simple_vault.ts
```

Для localnet используется кошелёк `devnet-wallet.json` из `Anchor.toml`.
Локальная сеть не требует devnet SOL.

### 5. Получить devnet SOL

```bash
solana address --keypair ./devnet-wallet.json
solana airdrop 2 --url devnet --keypair ./devnet-wallet.json
solana balance --url devnet --keypair ./devnet-wallet.json
# Если airdrop ограничен, используйте https://faucet.solana.com
```

> Баланс должен покрывать rent программы и создание тестовых аккаунтов.
> Размер rent зависит от бинарника и максимальной длины программного аккаунта.

### 6. Задеплоить на devnet

```bash
anchor deploy --provider.cluster devnet
```

Успешный вывод:
```
Program Id: DTYAxMLXSQzFWm79VAHsSNF9Bitm34QkEwc2571nyBZS
Deploy success
```

### 7. Запустить тесты на devnet

```bash
npm run test:devnet
```

---

## Структура проекта

```
vault-dev/
├── Anchor.toml                  # конфиг: cluster=devnet, program ID
├── Cargo.toml                   # workspace
├── package.json
├── tsconfig.json
├── programs/
│   └── simple_vault/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs           # весь контракт (инструкции + аккаунты + ошибки)
└── tests/
    └── vault.ts                 # TypeScript тесты (три пользователя)
```

---

## Тест-сценарий

Тесты (`tests/vault.ts`) покрывают:

1. **initialize_vault** — сохраняет admin, fee_wallet, минимум в один токен и выключенную паузу.
2. **Валидация** — нулевой и слишком маленький депозит отклоняются, fee_wallet нельзя подменить.
3. **Три пользователя** вносят 100, 50 и 25 токенов; комиссия уходит отдельно, shares отражают остаток.
4. **Границы** — ровно один токен принимается, дробная комиссия округляется вниз.
5. **Пауза** — менять её может только admin, депозит во время паузы отклоняется, вывод работает.
6. **Возобновление** — после снятия паузы депозиты снова доступны.
7. **Полный вывод** — три пользователя сжигают все shares; баланс vault, total_tokens,
   total_shares и supply share mint равны нулю. Пользователи теряют только комиссию,
   которая остаётся на fee_wallet.

После отклонённых операций тесты проверяют неизменность state, балансов и supply.
Дополнительно проверяются откат перевода при нехватке средств на комиссию, нулевой вывод
и попытка вывести больше собственных shares.

---

## PDAs (Seeds)

| PDA | Seeds |
|---|---|
| `vault_state` | `["vault", token_mint]` |
| `vault_token_account` | `["vault_tokens", token_mint]` |
| `share_mint` | `["share_mint", token_mint]` |

---

## Возможные ошибки

| Ошибка | Причина |
|---|---|
| `insufficient funds` при деплое | Нужно больше SOL → `solana airdrop` или https://faucet.solana.com |
| `AccountNotInitialized` в тестах | Забыл задеплоить или указан неверный cluster |
| `ZeroAmount` | Передан `amount = 0` |
| `SharesTooSmall` | Депозит слишком мал относительно TVL vault |
| `DepositTooSmall` | Депозит меньше одного целого токена |
| `VaultPaused` | Admin остановил депозиты |
| `Unauthorized` | Паузу пытается изменить не admin |
| `ConstraintAddress` | Подменён fee_wallet |

---

## Задание для практики

Выполнено для 9-й недели:

- [x] Добавить **комиссию 1%** при депозите (переводить на `fee_wallet`)
- [x] Добавить **паузу** (`is_paused: bool`) — admin может остановить депозиты
- [x] Добавить **минимальный депозит** (например, ≥ 1 токен)
- [x] Написать тест: **три пользователя** делают deposit → все выводят → vault пуст
