# Milestone 4c — Cross-Currency Transfers / FX Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking. Implements `../specs/2026-07-23-wallet-milestone-4c-fx-conversion-design.md`.

**Goal:** A customer moves money from a wallet they own into a wallet in a **different** currency; the
system fetches a live mid-market rate, converts the amount (banker's rounded), and settles atomically —
debiting the source in its currency and crediting the destination in its currency, with the rate recorded
on the ledger.

**Architecture:** A cross-currency transfer **is** an M4b transfer plus a rate. A new `RatesService`
(sole owner of the external FX HTTP call, behind a swappable module) is called **before** the transaction
opens — the rate and the destination currency are read pre-lock because `currency` is immutable, exactly
like M4a's `type`. The existing `WalletsService.transfer` is extended to convert when currencies differ;
the sorted two-wallet locking, linked-pair ledger, and response-privacy rule from 4b are reused unchanged.

**Tech Stack:** NestJS 11, Prisma 6 (`Prisma.Decimal` = Decimal.js, for exact math + `ROUND_HALF_EVEN`),
PostgreSQL 16, Node 24 global `fetch`, Frankfurter API (`api.frankfurter.app`, keyless), Jest.

## Global Constraints

- **Money is integer minor units.** `amount` (the debit) is always positive; the credit is the computed,
  banker's-rounded conversion.
- **Fetch the rate BEFORE `$transaction` opens.** An external HTTP call must never run while holding wallet
  locks (M4a's "no unrelated I/O under a lock", worse here — it can hang for seconds holding two locks).
- **Read `currency` pre-lock (it is immutable); re-read only `balance` under the lock.** Same reasoning as
  M4a's `type`.
- **Lock BOTH wallets in sorted-id order, two separate `FOR UPDATE` statements.** Unchanged from 4b.
- **Banker's rounding (round-half-to-even) on the credited side**, via `Prisma.Decimal(...).times(rate)
  .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_EVEN)`. Never `Math.round` (it is half-up).
- **Fail-closed:** any rate-lookup failure → `503`, no money moves. No caching / stale fallback.
- **The response returns only the sender's `transfer_out` row.** (4b rule — the receiver's row leaks their
  balance.)
- **`RatesService` is the ONLY place the app makes the FX HTTP call.**
- `WalletsModule` remains the only place `prisma.wallet` / `prisma.transaction` are touched.
- Any type used in a **decorated signature** must use `import type` (TS1272). `AuthUser` is such a type.
- `npx tsc --noEmit` and `npm test` (run from `backend/`) are the source of truth, not editor squiggles.
- One conventional commit per task. The user pushes.

---

## File structure changed in this milestone

```
backend/
├── prisma/
│   └── schema.prisma                 # MODIFIED: Transaction gains exchangeRate Decimal?
└── src/
    ├── rates/
    │   ├── rates.service.ts          # NEW: Frankfurter fetch → Prisma.Decimal, 503 on any failure
    │   ├── rates.service.spec.ts     # NEW: 5 tests, mocked fetch
    │   └── rates.module.ts           # NEW: provides + exports RatesService
    └── wallets/
        ├── wallets.service.ts        # MODIFIED: transfer() converts cross-currency
        ├── wallets.service.spec.ts   # MODIFIED: buildService gains a RatesService mock; +conversion tests
        └── wallets.module.ts         # MODIFIED: imports RatesModule
```

The **controller and `TransferDto` are unchanged** — the same `POST /wallets/:id/transfers` endpoint
transparently handles FX; the difference is detected from the wallets' currencies, not the request.

Starting point: **7 suites / 61 tests** (M4b end state). Ending point: **8 suites / 69 tests**.

---

## Task 1: Schema + migration

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Interfaces:**
- Produces: `Transaction.exchangeRate` (`Decimal?`) on the typed Prisma client, consumed by Task 3.

- [ ] **Step 1: Baseline green.** A schema change is safest from a clean, passing state.

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; **7 suites, 61 tests** passing (M4b end state).

- [ ] **Step 2: Add the field.** In `backend/prisma/schema.prisma`, inside `model Transaction { … }`,
      find the transfer block added in 4b:

```prisma
  // Transfers only: the other wallet in the pair, so a row is self-describing without a second query.
  counterpartyWalletId String?
  createdAt     DateTime  @default(now())
```
Replace with:
```prisma
  // Transfers only: the other wallet in the pair, so a row is self-describing without a second query.
  counterpartyWalletId String?
  // Cross-currency transfers only: the rate applied (in.amount = round(out.amount * rate)). Null for
  // same-currency transfers and all non-transfer rows. Recorded so the conversion is auditable/reproducible.
  exchangeRate  Decimal?
  createdAt     DateTime  @default(now())
```

> **Note (deliberate):** `Decimal?` maps to Postgres `numeric` and to `Prisma.Decimal` (Decimal.js) in
> code — exact decimal math, no float error, and a built-in `ROUND_HALF_EVEN` mode. No new table: the rate
> is one field on the existing ledger row, tying the pair that already shares a `transferId`.

- [ ] **Step 3: Generate the migration.** Postgres must be up (`docker compose ps`; if the daemon is
      down, `open -a Docker` and wait). This also regenerates the typed client.

```bash
cd backend && npm run prisma:migrate -- --name add_exchange_rate
```
Expected: a new folder `prisma/migrations/…_add_exchange_rate`, and "Your database is now in sync with
your schema." The column is nullable, so existing rows need no backfill. If it prompts to reset, **stop**
and investigate (do not reset — the dev DB holds demo data; and a reset needs a manual re-seed, see the
project memory note).

- [ ] **Step 4: Verify.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; still **7 suites / 61 tests** (schema only, no new tests).

- [ ] **Step 5: Commit.**

```bash
git add backend/prisma
git commit -m "feat: add exchangeRate to Transaction (Milestone 4c, Task 1)"
```

---

## Task 2: `RatesModule` / `RatesService` — TDD

**Files:**
- Create: `backend/src/rates/rates.service.ts`
- Create: `backend/src/rates/rates.service.spec.ts`
- Create: `backend/src/rates/rates.module.ts`

**Interfaces:**
- Produces: `RatesService.getRate(from: string, to: string): Promise<Prisma.Decimal>` — returns the rate,
  throws `ServiceUnavailableException` (`503`) on any failure; returns `Decimal(1)` for `from === to`
  without calling the network. Consumed by Task 3.
- Produces: `RatesModule` exporting `RatesService`. Imported by `WalletsModule` in Task 3.

- [ ] **Step 1: Write the failing tests** at `backend/src/rates/rates.service.spec.ts`. `fetch` is a Node
      global; we stub it with `jest.spyOn(global, 'fetch')`.

```typescript
import { ServiceUnavailableException } from '@nestjs/common';
import { RatesService } from './rates.service';

// A minimal stand-in for the parts of the fetch Response we use.
const fakeResponse = (body: any, ok = true) =>
  ({ ok, json: () => Promise.resolve(body) }) as unknown as Response;

describe('RatesService', () => {
  const service = new RatesService();

  afterEach(() => jest.restoreAllMocks());

  it('parses the rate for the requested pair', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse({ rates: { EUR: 0.9234 } }));
    const rate = await service.getRate('USD', 'EUR');
    expect(rate.toString()).toBe('0.9234');
  });

  it('short-circuits same-currency to 1 without hitting the network', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const rate = await service.getRate('USD', 'USD');
    expect(rate.toString()).toBe('1');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws 503 when the provider returns a non-200', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse({}, false));
    await expect(service.getRate('USD', 'EUR')).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws 503 when the network call itself fails', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.getRate('USD', 'EUR')).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws 503 when the pair is absent from the response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse({ rates: {} }));
    await expect(service.getRate('USD', 'XYZ')).rejects.toThrow(ServiceUnavailableException);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

```bash
cd backend && npm test -- rates.service
```
Expected: FAIL — cannot find module `./rates.service`.

- [ ] **Step 3: Implement the service** at `backend/src/rates/rates.service.ts`:

```typescript
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * The ONLY place the app talks to an external FX provider. Isolated behind this seam so a
 * future swap (a keyed provider, a cache) is a one-file change that never touches wallet logic.
 * Fail-closed: any failure throws 503 and the caller moves no money.
 */
@Injectable()
export class RatesService {
  private readonly base = 'https://api.frankfurter.app';

  async getRate(from: string, to: string): Promise<Prisma.Decimal> {
    // No conversion needed — never bother the network.
    if (from === to) return new Prisma.Decimal(1);

    let res: Response;
    try {
      res = await fetch(`${this.base}/latest?base=${from}&symbols=${to}`);
    } catch {
      throw new ServiceUnavailableException('Exchange rate provider unavailable');
    }
    if (!res.ok) {
      throw new ServiceUnavailableException('Exchange rate provider unavailable');
    }

    const body = (await res.json()) as { rates?: Record<string, number> };
    const rate = body?.rates?.[to];
    if (rate == null) {
      throw new ServiceUnavailableException(`No exchange rate for ${from} -> ${to}`);
    }
    return new Prisma.Decimal(rate);
  }
}
```

- [ ] **Step 4: Create the module** at `backend/src/rates/rates.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { RatesService } from './rates.service';

@Module({
  providers: [RatesService],
  exports: [RatesService],
})
export class RatesModule {}
```

- [ ] **Step 5: Run the tests — green.**

```bash
cd backend && npm test -- rates.service
```
Expected: **5 tests passing** in `rates.service`.

- [ ] **Step 6: Full suite + typecheck.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; **8 suites / 66 tests** (61 + 5). `RatesModule` is not wired into anything yet —
that happens in Task 3 — but the service stands alone and its tests pass.

- [ ] **Step 7: Commit.**

```bash
git add backend/src/rates
git commit -m "feat: add RatesService (Frankfurter FX feed, fail-closed) (Milestone 4c, Task 2)"
```

---

## Task 3: Extend `WalletsService.transfer` to convert — TDD

**Files:**
- Modify: `backend/src/wallets/wallets.service.spec.ts`
- Modify: `backend/src/wallets/wallets.service.ts`
- Modify: `backend/src/wallets/wallets.module.ts`

**Interfaces:**
- Consumes: `RatesService.getRate` (Task 2); the existing `getOwnedWallet`, `transferPrisma`,
  `buildService`, `wallet()`, `actor`, `other` helpers in the spec.
- Produces: `WalletsService.transfer` now converts when the two wallets' currencies differ; both ledger
  rows carry `exchangeRate` (the rate, or `null` for same-currency).

- [ ] **Step 1: Update the test harness.** In `backend/src/wallets/wallets.service.spec.ts`:

  **(a)** Add `ServiceUnavailableException` to the `@nestjs/common` import and add two imports below the
  `AuthUser` import:

```typescript
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
```
```typescript
import type { AuthUser } from '../auth/jwt.strategy';
import { Prisma } from '@prisma/client';
import { RatesService } from '../rates/rates.service';
```

  **(b)** Give `buildService` a third parameter that provides a `RatesService` mock (default: a bare
  `getRate` jest fn). Replace the existing `buildService` function with:

```typescript
function buildService(
  prismaMock: any,
  usersMock: any = { findByIdWithPermissions: jest.fn() },
  ratesMock: any = { getRate: jest.fn() },
) {
  return Test.createTestingModule({
    providers: [
      WalletsService,
      { provide: PrismaService, useValue: prismaMock },
      { provide: UsersService, useValue: usersMock },
      { provide: RatesService, useValue: ratesMock },
    ],
  })
    .compile()
    .then((moduleRef) => moduleRef.get(WalletsService));
}
```

> Existing calls `buildService(prisma)` / `buildService(prisma, usersMock)` keep working — the new
> parameter is defaulted. Same-currency tests never trigger a rate call, so the default mock is enough.

- [ ] **Step 2: Replace the 4b cross-currency rejection test with conversion tests.** In the
      `describe('WalletsService.transfer', …)` block, **delete** this test (cross-currency is no longer a
      rejection):

```typescript
  it('rejects a cross-currency transfer and moves no money', async () => {
    const { txDouble, prisma } = transferPrisma({
      'wallet-2': wallet({ id: 'wallet-2', userId: 'user-2', balance: 100, currency: 'EUR' }),
    });
    const service = await buildService(prisma);

    await expect(
      service.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 100 }),
    ).rejects.toThrow(BadRequestException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
    expect(txDouble.transaction.create).not.toHaveBeenCalled();
  });
```

  and **add** these four tests in its place (inside the same `describe`):

```typescript
  it('converts a cross-currency transfer at the fetched rate and stamps it on both rows', async () => {
    const { txDouble, prisma } = transferPrisma({
      'wallet-2': wallet({ id: 'wallet-2', userId: 'user-2', balance: 100, currency: 'EUR' }),
    });
    const rates = { getRate: jest.fn().mockResolvedValue(new Prisma.Decimal('0.9')) };
    const service = await buildService(prisma, undefined, rates);

    await service.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 1000 });

    // The rate was fetched with the two wallets' currencies, source -> destination.
    expect(rates.getRate).toHaveBeenCalledWith('USD', 'EUR');

    const [outRow, inRow] = txDouble.transaction.create.mock.calls.map((c: any[]) => c[0].data);
    expect(outRow.amount).toBe(1000);          // debit, in the source currency
    expect(inRow.amount).toBe(900);            // credit, 1000 * 0.9, in the destination currency
    expect(outRow.exchangeRate.toString()).toBe('0.9');
    expect(inRow.exchangeRate.toString()).toBe('0.9');

    // Balances: source debited by the amount, destination credited by the converted amount.
    expect(txDouble.wallet.update).toHaveBeenCalledWith({ where: { id: 'wallet-1' }, data: { balance: 4000 } });
    expect(txDouble.wallet.update).toHaveBeenCalledWith({ where: { id: 'wallet-2' }, data: { balance: 1000 } });
  });

  it('rounds the credited side half-to-even (banker\'s rounding), not half-up', async () => {
    // Ties that distinguish the two rules: 2.5 -> 2 and 4.5 -> 4 under half-to-even;
    // half-up would give 3 and 5. amount 100 * rate lands exactly on the .5 tie.
    const creditFor = async (rate: string) => {
      const { txDouble, prisma } = transferPrisma({
        'wallet-2': wallet({ id: 'wallet-2', userId: 'user-2', balance: 0, currency: 'EUR' }),
      });
      const rates = { getRate: jest.fn().mockResolvedValue(new Prisma.Decimal(rate)) };
      const service = await buildService(prisma, undefined, rates);
      await service.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 100 });
      const inRow = txDouble.transaction.create.mock.calls
        .map((c: any[]) => c[0].data)
        .find((d: any) => d.type === 'transfer_in');
      return inRow.amount;
    };

    expect(await creditFor('0.025')).toBe(2); // 2.5 -> 2 (even); half-up would give 3
    expect(await creditFor('0.045')).toBe(4); // 4.5 -> 4 (even); half-up would give 5
  });

  it('fails with 503 and moves no money when the rate provider is down', async () => {
    const { txDouble, prisma } = transferPrisma({
      'wallet-2': wallet({ id: 'wallet-2', userId: 'user-2', balance: 100, currency: 'EUR' }),
    });
    const rates = { getRate: jest.fn().mockRejectedValue(new ServiceUnavailableException('down')) };
    const service = await buildService(prisma, undefined, rates);

    await expect(
      service.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 100 }),
    ).rejects.toThrow(ServiceUnavailableException);

    // Fail-closed happens BEFORE the transaction opens — nothing was locked or written.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(txDouble.transaction.create).not.toHaveBeenCalled();
  });

  it('does not call the rate provider for a same-currency transfer', async () => {
    const { prisma } = transferPrisma(); // both wallets USD
    const rates = { getRate: jest.fn() };
    const service = await buildService(prisma, undefined, rates);

    await service.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 100 });

    expect(rates.getRate).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run them and watch them fail.**

```bash
cd backend && npm test -- wallets.service
```
Expected: FAIL — the conversion tests fail (the current `transfer` still rejects cross-currency with
`400` / never calls `rates.getRate`). The same-currency and 503 tests may error on DI until Step 4.

- [ ] **Step 4: Implement.** Three edits in order.

  **(a)** In `backend/src/wallets/wallets.service.ts`, add two imports below the existing
  `import type { AuthUser } …` and `import { randomUUID } from 'crypto';` lines:

```typescript
import { Prisma } from '@prisma/client';
import { RatesService } from '../rates/rates.service';
```

  **(b)** Add `rates` to the constructor:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly rates: RatesService,
  ) {}
```

  **(c)** Replace the entire `transfer` method with the version below. The changes from 4b: the source
  wallet returned by `getOwnedWallet` is captured; the destination is read **pre-lock** for existence +
  currency; when the currencies differ the rate is fetched **before** the transaction and the credit is
  computed with banker's rounding; `amount` moves **out** of the shared object (each row records its own
  currency's amount); and `exchangeRate` is stamped on both rows.

```typescript
  /**
   * Instant wallet-to-wallet transfer. Same currency: moves `amount` unchanged (M4b). Different
   * currencies: fetches a live rate BEFORE the transaction opens (never hold locks across an external
   * call), converts with banker's rounding, and records the rate on both linked ledger rows.
   */
  async transfer(
    fromWalletId: string,
    actor: AuthUser,
    dto: { toWalletId: string; amount: number; note?: string },
  ) {
    if (dto.toWalletId === fromWalletId) {
      throw new BadRequestException('Cannot transfer to the same wallet');
    }

    // Ownership of the SOURCE only, before the transaction opens. Returns the wallet (immutable
    // currency is all we need from it here; the mutable balance is re-read under the lock).
    const source = await this.getOwnedWallet(fromWalletId, actor);

    // Destination existence + currency, read before the lock. `currency` is immutable per wallet,
    // so reading it early is safe (same reasoning as M4a's `type`).
    const dest = await this.prisma.wallet.findUnique({ where: { id: dto.toWalletId } });
    if (!dest) throw new NotFoundException('Destination wallet not found');

    // Fetch the rate BEFORE the lock — an external HTTP call must never run while holding two wallet
    // locks. With `amount` (caller-supplied) and the rate both known, the entire conversion is
    // determined here, before anything is locked. Same currency => no rate call, credit == amount.
    let exchangeRate: Prisma.Decimal | null = null;
    let credit = dto.amount;
    if (source.currency !== dest.currency) {
      exchangeRate = await this.rates.getRate(source.currency, dest.currency); // 503 on failure
      credit = new Prisma.Decimal(dto.amount)
        .times(exchangeRate)
        .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_EVEN) // banker's rounding
        .toNumber();
    }

    const transferId = randomUUID();
    const [firstLock, secondLock] = [fromWalletId, dto.toWalletId].sort();

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${firstLock} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${secondLock} FOR UPDATE`;

      // Re-read under the locks: only the balances are mutable and must be trusted here.
      const from = await tx.wallet.findUnique({ where: { id: fromWalletId } });
      if (!from) throw new NotFoundException('Wallet not found');
      const to = await tx.wallet.findUnique({ where: { id: dto.toWalletId } });
      if (!to) throw new NotFoundException('Destination wallet not found');

      if (from.balance < dto.amount) throw new BadRequestException('Insufficient funds');

      const fromAfter = from.balance - dto.amount;
      const toAfter = to.balance + credit;
      const settledAt = new Date();

      await tx.wallet.update({ where: { id: from.id }, data: { balance: fromAfter } });
      await tx.wallet.update({ where: { id: to.id }, data: { balance: toAfter } });

      // Shared across both halves. `amount` is NOT shared — each row records its OWN currency's
      // amount (the debit on the sender, the converted credit on the receiver). `exchangeRate` is
      // the same on both (null for a same-currency transfer).
      const shared = {
        transferId,
        status: 'approved',
        requestedBy: actor.id,
        reviewedBy: actor.id,
        reviewedAt: settledAt,
        note: dto.note,
        exchangeRate,
      };

      const outRow = await tx.transaction.create({
        data: {
          ...shared,
          walletId: from.id,
          type: 'transfer_out',
          amount: dto.amount,
          counterpartyWalletId: to.id,
          balanceBefore: from.balance,
          balanceAfter: fromAfter,
        },
      });

      await tx.transaction.create({
        data: {
          ...shared,
          walletId: to.id,
          type: 'transfer_in',
          amount: credit,
          counterpartyWalletId: from.id,
          balanceBefore: to.balance,
          balanceAfter: toAfter,
        },
      });

      // Only the sender's row is returned: the receiver's row carries their balance.
      return outRow;
    });
  }
```

  **(d)** In `backend/src/wallets/wallets.module.ts`, import `RatesModule` and add it to `imports`:

```typescript
import { RatesModule } from '../rates/rates.module';
```
```typescript
  imports: [UsersModule, RatesModule],
```

- [ ] **Step 5: Run the transfer tests — green.**

```bash
cd backend && npm test -- wallets.service
```
Expected: **35 tests passing** in `wallets.service` (32 from M4b − 1 removed + 4 new).

- [ ] **Step 6: Full suite + typecheck.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; **8 suites / 69 tests** (66 + 3 net).

- [ ] **Step 7: Commit.**

```bash
git add backend/src/wallets
git commit -m "feat: convert cross-currency transfers at a live rate (Milestone 4c, Task 3)"
```

---

## Task 4: Live proofs + review, learning notes, memory

**Files:**
- Modify: `docs/learning-notes.md`
- Possibly modify: any file the review turns up

- [ ] **Step 1: Start Postgres + the dev server.** If the DB was reset since M4b, re-seed first (this repo
      has no `prisma.seed` hook, so `migrate reset` does NOT auto-seed):

```bash
cd /Users/max/Documents/GitHub/wallet-system
docker compose up -d
cd backend && npm run prisma:seed   # only needed if the DB was reset; harmless (idempotent upserts) otherwise
npm run start:dev                    # leave running in the background
```
Wait until `curl -s -o /dev/null http://localhost:3000/auth/login` responds.

- [ ] **Step 2: Set up a USD sender and a recipient with USD + EUR + a bogus-currency wallet.** Run as one
      block (shell variables do not persist between separate command invocations):

```bash
cd /Users/max/Documents/GitHub/wallet-system
ADMIN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@wallet.local","password":"ChangeMe123!"}' | jq -r .accessToken)

for who in fxalice fxbob; do
  curl -s -o /dev/null -X POST http://localhost:3000/auth/register -H 'Content-Type: application/json' \
    -d "{\"email\":\"$who@m4c.test\",\"password\":\"Password123\",\"firstName\":\"$who\",\"lastName\":\"T\"}"
done

ALICE=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"fxalice@m4c.test","password":"Password123"}' | jq -r .accessToken)
BOB=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"fxbob@m4c.test","password":"Password123"}' | jq -r .accessToken)

AW=$(curl -s -X POST http://localhost:3000/wallets -H "Authorization: Bearer $ALICE" \
  -H 'Content-Type: application/json' -d '{"name":"usd","currency":"USD"}' | jq -r .id)
BE=$(curl -s -X POST http://localhost:3000/wallets -H "Authorization: Bearer $BOB" \
  -H 'Content-Type: application/json' -d '{"name":"euro","currency":"EUR"}' | jq -r .id)
BU=$(curl -s -X POST http://localhost:3000/wallets -H "Authorization: Bearer $BOB" \
  -H 'Content-Type: application/json' -d '{"name":"usd","currency":"USD"}' | jq -r .id)
BX=$(curl -s -X POST http://localhost:3000/wallets -H "Authorization: Bearer $BOB" \
  -H 'Content-Type: application/json' -d '{"name":"bogus","currency":"XYZ"}' | jq -r .id)

curl -s -o /dev/null -X POST "http://localhost:3000/wallets/$AW/adjustments" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"direction":"credit","amount":100000,"note":"m4c float"}'

echo "alice usd=$AW  bob eur=$BE  bob usd=$BU  bob xyz=$BX"
```
Expected: four wallet ids; Alice's USD wallet holding `100000`.

- [ ] **Step 3: Proof — a real USD→EUR conversion.** The rate is live, so we assert *shape and invariants*
      (debit exact; credit = `round(debit × returned_rate)`; the rate recorded on both rows), not a fixed
      number. Run as one block:

```bash
cd /Users/max/Documents/GitHub/wallet-system
ALICE=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"fxalice@m4c.test","password":"Password123"}' | jq -r .accessToken)
BOB=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"fxbob@m4c.test","password":"Password123"}' | jq -r .accessToken)
AW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $ALICE" | jq -r '.[] | select(.currency=="USD") | .id')
BE=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $BOB" | jq -r '.[] | select(.currency=="EUR") | .id')

echo "== alice USD -> bob EUR, debit 50000 (expect 201, transfer_out with exchangeRate) =="
curl -s -X POST "http://localhost:3000/wallets/$AW/transfers" \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d "{\"toWalletId\":\"$BE\",\"amount\":50000,\"note\":\"fx\"}" \
  | jq -c '{type,amount,balanceBefore,balanceAfter,exchangeRate}'

echo "== alice USD ledger row (debit side) =="
curl -s "http://localhost:3000/wallets/$AW/transactions" -H "Authorization: Bearer $ALICE" \
  | jq -c '.[0] | {type,amount,exchangeRate,transferId}'
echo "== bob EUR ledger row (credit side; amount = round(50000 * rate)) =="
curl -s "http://localhost:3000/wallets/$BE/transactions" -H "Authorization: Bearer $BOB" \
  | jq -c '.[0] | {type,amount,exchangeRate,transferId}'
echo "== balances (alice down 50000 USD; bob up round(50000*rate) EUR) =="
curl -s "http://localhost:3000/wallets/$AW" -H "Authorization: Bearer $ALICE" | jq -c '{alice_usd:.balance}'
curl -s "http://localhost:3000/wallets/$BE" -H "Authorization: Bearer $BOB" | jq -c '{bob_eur:.balance}'
```
Expected: `201`; the `transfer_out` row has `amount 50000` and a non-null `exchangeRate`; the two ledger
rows share a `transferId`; the EUR credit equals `50000 × rate` banker's-rounded to a whole integer; Alice
USD = `50000`, Bob EUR = the converted credit.

- [ ] **Step 4: Proof — fail-closed on an unsupported currency (`503`, no money moves).** Transferring to
      the `XYZ` wallet forces `RatesService` to ask Frankfurter for a pair it does not have → `503`. Run as
      one block:

```bash
cd /Users/max/Documents/GitHub/wallet-system
ALICE=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"fxalice@m4c.test","password":"Password123"}' | jq -r .accessToken)
BOB=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"fxbob@m4c.test","password":"Password123"}' | jq -r .accessToken)
AW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $ALICE" | jq -r '.[] | select(.currency=="USD") | .id')
BX=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $BOB" | jq -r '.[] | select(.currency=="XYZ") | .id')

echo "== alice USD -> bob XYZ (expect 503) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3000/wallets/$AW/transfers" \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d "{\"toWalletId\":\"$BX\",\"amount\":100}"
echo "== alice USD balance unchanged (still 50000 from Step 3) =="
curl -s "http://localhost:3000/wallets/$AW" -H "Authorization: Bearer $ALICE" | jq -c '{alice_usd:.balance}'
```
Expected: `503`; Alice's balance **unchanged** — fail-closed happened before any lock or write.

- [ ] **Step 5: Regression — a same-currency transfer still works (no rate call).**

```bash
cd /Users/max/Documents/GitHub/wallet-system
ALICE=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"fxalice@m4c.test","password":"Password123"}' | jq -r .accessToken)
BOB=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"fxbob@m4c.test","password":"Password123"}' | jq -r .accessToken)
AW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $ALICE" | jq -r '.[] | select(.currency=="USD") | .id')
BU=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $BOB" | jq -r '.[] | select(.currency=="USD") | .id')

echo "== alice USD -> bob USD, 10000 (expect 201, exchangeRate null) =="
curl -s -X POST "http://localhost:3000/wallets/$AW/transfers" \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d "{\"toWalletId\":\"$BU\",\"amount\":10000}" | jq -c '{type,amount,exchangeRate}'
```
Expected: `201`; `amount 10000`; `exchangeRate` **null** (same currency = no conversion, no rate call).

- [ ] **Step 6: Full verification + boundary check.**

```bash
cd /Users/max/Documents/GitHub/wallet-system/backend && npx tsc --noEmit && npm test 2>&1 | tail -5
cd /Users/max/Documents/GitHub/wallet-system && grep -rn "prisma\.\(wallet\|transaction\)\." backend/src --include="*.ts" | grep -v ".spec.ts" | grep -v "src/wallets/" || echo "clean"
grep -rn "fetch(" backend/src --include="*.ts" | grep -v ".spec.ts" | grep -v "src/rates/" || echo "fetch confined to src/rates/"
```
Expected: **8 suites / 69 tests**; the wallet/transaction boundary prints `clean`; the `fetch` check
prints `fetch confined to src/rates/` (the external call lives only in `RatesService`).

- [ ] **Step 7: Run the spec's §12 checklist** (`../specs/2026-07-23-wallet-milestone-4c-fx-conversion-design.md`)
      and tick each box: rate fetched before `$transaction`; currency read pre-lock, balances under the
      lock; sorted-id locking intact; credited side round-half-to-even with tie tests; `exchangeRate` on
      both cross rows, null same-currency; provider failure → `503` with no writes; response returns only
      the sender's row; `RatesService` the only FX HTTP call.

- [ ] **Step 8: Read the diff with fresh eyes.** `git diff 372e0cf..HEAD -- backend/`. Check: is the rate
      fetch outside `$transaction`? Is `currency` read pre-lock and only `balance` re-read under the lock?
      Is `amount` per-row (debit vs credit) and not in the shared object? Is banker's rounding used (not
      `Math.round`)? Fix what you find; commit separately.

- [ ] **Step 9: Append the M4c sections to `docs/learning-notes.md`.** Cover, in plain English:
  - **A transfer with a rate** — cross-currency is M4b plus a conversion; the debit and credit are in
    different currencies, so they are not equal by design; the rate ties the pair.
  - **Fetch the rate before the lock** — external I/O must never run under a lock; the chicken-and-egg
    (need currency to know if a rate is needed) resolved by reading immutable `currency` early, exactly
    like M4a's `type`; the whole conversion is determined before any lock.
  - **Banker's rounding** — round-half-to-even, why it beats half-up (bias over volume), and that
    `Prisma.Decimal` gives exact math + `ROUND_HALF_EVEN` for free (no `Math.round`).
  - **Fail-closed** — a money movement never happens at an unknown rate; a provider outage is a `503`, not
    a stale-rate settlement; and this failure lands *before* any lock is taken.
  - **The swappable provider seam** — `RatesService` is the sole external-HTTP owner, so a keyed provider
    or a cache is a one-file change; note the `fetch`-confined-to-`src/rates/` boundary check.
  - **Deliberate non-goals** — fees/spread + treasury (post-M7), caching/TTL, keyed providers, multi-hop,
    caller-supplied rates.

- [ ] **Step 10: Milestone recap section** in `docs/learning-notes.md`, following the M4a/M4b recap shape:
      the endpoint is unchanged (same `POST /wallets/:id/transfers`), the cross-currency lifecycle
      (validate → read currency + fetch rate pre-lock → lock both sorted → re-read balances → convert &
      move → write the pair with the rate stamped → return sender's row), and the deferred list.

- [ ] **Step 11: Commit the notes.**

```bash
git add docs/learning-notes.md
git commit -m "docs: consolidate Milestone 4c learning notes (Milestone 4c, Task 4)"
```

- [ ] **Step 12: Update the project memory** at
      `/Users/max/.claude/projects/-Users-max-Documents-GitHub-wallet-system/memory/wallet-system-project.md`:
      mark M4c complete with its commit range and per-task ✅ list, and set the next step (KYC optional, or
      whatever the user chooses next). Update the `MEMORY.md` index line accordingly.

---

## Milestone 4c self-review checklist (run before the next milestone)

- [ ] `npm test` green (**69 tests**, 8 suites); `npx tsc --noEmit` clean.
- [ ] Clean commits, one per task.
- [ ] All three live proofs reproduced: a real USD→EUR conversion with the rate recorded on both rows; an
      unsupported-currency transfer → `503` with balances unchanged; a same-currency transfer still `201`
      with `exchangeRate` null.
- [ ] **You can explain:** why the rate is fetched before the lock (and why reading `currency` early is
      safe); why banker's rounding; why fail-closed beats a stale-rate fallback; and how the provider seam
      keeps a future swap to one file.

---

## What a later FX enhancement could cover (preview, not scheduled)

Fees and a **platform treasury/revenue account**: capture the spread or an explicit `fx_fee` row credited
to a revenue wallet — which forces the treasury-account design (whose account, who may withdraw, how it
reconciles). Also rate **caching with a TTL** (cut API calls, smooth over blips) and a swap to a **keyed
provider** with historical rates — both slotting behind the existing `RatesService` seam with no change to
wallet logic.
