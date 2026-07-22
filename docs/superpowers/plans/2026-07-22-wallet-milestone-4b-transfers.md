# Milestone 4b — Wallet-to-Wallet Transfers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking. Implements `../specs/2026-07-22-wallet-milestone-4b-transfers-design.md`.

**Goal:** A customer moves money from a wallet they own into any other wallet of the same currency.
The transfer settles instantly and atomically — both balances change, two linked ledger rows are
written sharing a `transferId`, and concurrent transfers can neither deadlock nor overdraw.

**Architecture:** One new method, `WalletsService.transfer`, plus one route on the existing
`WalletsController`. No new module, no new table. The method locks **both** wallet rows inside a single
Prisma interactive transaction, in an order determined by **sorting the two wallet ids** — which is what
makes deadlock impossible when Alice→Bob and Bob→Alice run concurrently. Ownership is checked on the
**source only**; the destination belongs to someone else by definition.

**Tech Stack:** NestJS 11, Prisma 6 (`prisma-client-js`), PostgreSQL 16, Jest, class-validator.

## Global Constraints

- **Money is integer minor units.** `amount` always **positive**; `type` carries direction
  (`transfer_out` / `transfer_in`).
- **A balance must never go below 0.** Enforced under the lock.
- **Lock BOTH wallets, in sorted-id order, before reading any balance.** Never sender-then-receiver.
  Use **two separate `FOR UPDATE` statements** — not `WHERE id IN (a,b) ORDER BY id`, because Postgres
  locks rows in plan order, not `ORDER BY` order.
- **Do no unrelated I/O under a lock** (the M4a lesson). Ownership and the self-transfer check happen
  **before** the transaction opens; everything mutable (balances, currencies, destination existence) is
  read **under** the locks.
- **The response returns only the sender's `transfer_out` row.** The receiver's row carries their
  `balanceBefore`/`balanceAfter` — returning it would disclose their balance to the sender.
- `403` = source not owned. `404` = source or destination missing. `400` = self-transfer, currency
  mismatch, insufficient funds, bad amount. **No `409` here** — there is no pending row to settle twice.
- `WalletsModule` remains the **only** place `prisma.wallet` / `prisma.transaction` are touched.
- Any type used in a **decorated signature** must use `import type` (TS1272). `AuthUser` is such a type.
- `npx tsc --noEmit` and `npm test` (run from `backend/`) are the source of truth, not editor squiggles.
- One conventional commit per task. The user pushes.

---

## File structure changed in this milestone

```
backend/
├── prisma/
│   └── schema.prisma                 # MODIFIED: Transaction gains transferId + counterpartyWalletId
└── src/
    └── wallets/
        ├── wallets.service.ts        # MODIFIED: + transfer()
        ├── wallets.service.spec.ts   # MODIFIED: + 9 transfer tests
        ├── wallets.controller.ts     # MODIFIED: + POST /wallets/:id/transfers
        └── dto/
            └── transfer.dto.ts       # NEW
```

Starting point: **7 suites / 52 tests** (M4a end state). Ending point: **7 suites / 61 tests**.

---

## Task 1: Schema + migration

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Interfaces:**
- Produces: `Transaction.transferId` (`String?`, indexed) and `Transaction.counterpartyWalletId`
  (`String?`) on the typed Prisma client, consumed by Task 2.

- [ ] **Step 1: Baseline green.** A schema change is safest from a clean, passing state.

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; **7 suites, 52 tests** passing (M4a end state).

- [ ] **Step 2: Add the two fields.** In `backend/prisma/schema.prisma`, inside the existing
      `model Transaction { … }` block, replace the `note` line and the index block. Find:

```prisma
  note          String?
  createdAt     DateTime  @default(now())

  @@index([walletId])
  @@index([status])
}
```
Replace with:
```prisma
  note          String?
  // Transfers only: both halves of one transfer share this id, so the pair is provably one event.
  transferId    String?
  // Transfers only: the other wallet in the pair, so a row is self-describing without a second query.
  counterpartyWalletId String?
  createdAt     DateTime  @default(now())

  @@index([walletId])
  @@index([status])
  @@index([transferId])
}
```

> **Note (deliberate):** no `Transfer` table. Consistent with `requestedBy`/`reviewedBy`, which are plain
> id strings because nothing queries across them. A shared `transferId` gives the same linkage at zero
> schema cost; promoting it to a table later is a small migration.

- [ ] **Step 3: Generate the migration.** Postgres must be up (`docker compose ps`; if the daemon is
      down, `open -a Docker` and wait). This also regenerates the typed client.

```bash
cd backend && npm run prisma:migrate -- --name add_transfer_fields
```
Expected: a new folder `prisma/migrations/…_add_transfer_fields`, and "Your database is now in sync with
your schema." Both columns are nullable, so existing rows need no backfill. If it prompts to reset,
**stop** — that indicates drift; investigate rather than resetting (the dev DB holds the M4a demo data).

- [ ] **Step 4: Verify.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; still **7 suites / 52 tests** (no new tests — this is schema only).

- [ ] **Step 5: Commit.**

```bash
git add backend/prisma
git commit -m "feat: add transferId and counterpartyWalletId to Transaction (Milestone 4b, Task 1)"
```

---

## Task 2: `WalletsService.transfer` — TDD

**Files:**
- Modify: `backend/src/wallets/wallets.service.ts`
- Test: append to `backend/src/wallets/wallets.service.spec.ts`

**Interfaces:**
- Consumes: private `getOwnedWallet(id, actor)` from M4a Task 2 (throws `404` if missing, `403` if not
  owned, else returns the wallet); the `wallet()` factory, `buildService()`, `txPrisma()`, `actor` and
  `other` helpers already in the spec file.
- Produces: `WalletsService.transfer(fromWalletId: string, actor: AuthUser, dto: { toWalletId: string;
  amount: number; note?: string })` → the sender's `transfer_out` transaction row.

- [ ] **Step 1: Write the failing tests.** Append to `backend/src/wallets/wallets.service.spec.ts`.
      The `transferPrisma` helper below returns an **id-aware** mock: `findUnique` looks the wallet up by
      id, so the same mock can serve both `getOwnedWallet` (outside the transaction) and the two reads
      inside it.

```typescript
// Two wallets: 'wallet-1' owned by user-1 (the actor), 'wallet-2' owned by user-2.
// findUnique is id-aware so one mock serves both the pre-lock ownership read and the
// two reads inside the transaction.
function transferPrisma(overrides: Record<string, any> = {}) {
  const rows: Record<string, any> = {
    'wallet-1': wallet({ id: 'wallet-1', userId: 'user-1', balance: 5000 }),
    'wallet-2': wallet({ id: 'wallet-2', userId: 'user-2', balance: 100 }),
    ...overrides,
  };
  const txDouble = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    wallet: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(rows[where.id] ?? null)),
      update: jest.fn().mockResolvedValue(undefined),
    },
    transaction: {
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: `txn-${data.type}`, ...data }),
      ),
    },
  };
  return { txDouble, prisma: txPrisma(txDouble) };
}

describe('WalletsService.transfer', () => {
  it('writes a linked pair with a shared transferId and unbroken chains', async () => {
    const { txDouble, prisma } = transferPrisma();
    const service = await buildService(prisma);

    const result = await service.transfer('wallet-1', actor, {
      toWalletId: 'wallet-2',
      amount: 2000,
    });

    const [outRow, inRow] = txDouble.transaction.create.mock.calls.map((call: any[]) => call[0].data);

    expect(outRow.type).toBe('transfer_out');
    expect(outRow.walletId).toBe('wallet-1');
    expect(outRow.balanceBefore).toBe(5000);
    expect(outRow.balanceAfter).toBe(3000);
    expect(outRow.counterpartyWalletId).toBe('wallet-2');

    expect(inRow.type).toBe('transfer_in');
    expect(inRow.walletId).toBe('wallet-2');
    expect(inRow.balanceBefore).toBe(100);
    expect(inRow.balanceAfter).toBe(2100);
    expect(inRow.counterpartyWalletId).toBe('wallet-1');

    // One event: both halves carry the same id.
    expect(outRow.transferId).toBeTruthy();
    expect(inRow.transferId).toBe(outRow.transferId);

    // Both rows are settled at creation, credited to the sender.
    expect(outRow.status).toBe('approved');
    expect(inRow.status).toBe('approved');
    expect(inRow.requestedBy).toBe('user-1');

    // Only the sender's row is returned — the receiver's balance must not leak.
    expect(result.type).toBe('transfer_out');
  });

  it('debits the sender and credits the receiver by the same amount', async () => {
    const { txDouble, prisma } = transferPrisma();
    const service = await buildService(prisma);

    await service.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 2000 });

    expect(txDouble.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balance: 3000 },
    });
    expect(txDouble.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-2' },
      data: { balance: 2100 },
    });
  });

  it('locks both wallets in sorted-id order regardless of direction', async () => {
    // This is the deadlock-prevention property, asserted directly: whichever way the
    // money flows, the locks are taken in the same order.
    const forward = transferPrisma();
    const forwardService = await buildService(forward.prisma);
    await forwardService.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 100 });

    const backward = transferPrisma();
    const backwardService = await buildService(backward.prisma);
    await backwardService.transfer('wallet-2', other, { toWalletId: 'wallet-1', amount: 50 });

    // $queryRaw is a tagged template: call[0] is the strings array, call[1] the interpolated id.
    const lockedForward = forward.txDouble.$queryRaw.mock.calls.map((call: any[]) => call[1]);
    const lockedBackward = backward.txDouble.$queryRaw.mock.calls.map((call: any[]) => call[1]);

    expect(lockedForward).toEqual(['wallet-1', 'wallet-2']);
    expect(lockedBackward).toEqual(['wallet-1', 'wallet-2']);
  });

  it('rejects a transfer to the same wallet without opening a transaction', async () => {
    const { prisma } = transferPrisma();
    const service = await buildService(prisma);

    await expect(
      service.transfer('wallet-1', actor, { toWalletId: 'wallet-1', amount: 100 }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

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

  it('rejects a transfer larger than the sender’s balance', async () => {
    const { txDouble, prisma } = transferPrisma();
    const service = await buildService(prisma);

    await expect(
      service.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 9000 }),
    ).rejects.toThrow(BadRequestException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
    expect(txDouble.transaction.create).not.toHaveBeenCalled();
  });

  it('refuses to send from a wallet the actor does not own', async () => {
    const { txDouble, prisma } = transferPrisma();
    const service = await buildService(prisma);

    // 'other' is user-2, who does not own wallet-1.
    await expect(
      service.transfer('wallet-1', other, { toWalletId: 'wallet-2', amount: 100 }),
    ).rejects.toThrow(ForbiddenException);
    expect(txDouble.transaction.create).not.toHaveBeenCalled();
  });

  it('throws 404 when the source wallet does not exist', async () => {
    const { prisma } = transferPrisma();
    const service = await buildService(prisma);

    await expect(
      service.transfer('ghost', actor, { toWalletId: 'wallet-2', amount: 100 }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws 404 when the destination wallet does not exist', async () => {
    const { txDouble, prisma } = transferPrisma();
    const service = await buildService(prisma);

    await expect(
      service.transfer('wallet-1', actor, { toWalletId: 'ghost', amount: 100 }),
    ).rejects.toThrow(NotFoundException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

```bash
cd backend && npm test -- wallets.service
```
Expected: FAIL — `service.transfer is not a function`, 9 failing / 52 passing.

- [ ] **Step 3: Implement.** In `backend/src/wallets/wallets.service.ts`, add this import at the top of
      the file, directly below the existing `import type { AuthUser } …` line:

```typescript
import { randomUUID } from 'crypto';
```

Then add this method to `WalletsService`, directly above the private `getSettleableType` method:

```typescript
  /**
   * Instant wallet-to-wallet transfer, same currency. Writes a linked pair of settled
   * ledger rows (transfer_out on the sender, transfer_in on the receiver) sharing a
   * transferId, and moves both balances inside one DB transaction.
   */
  async transfer(
    fromWalletId: string,
    actor: AuthUser,
    dto: { toWalletId: string; amount: number; note?: string },
  ) {
    // Checked before the transaction: locking one row twice is meaningless, and the
    // arithmetic below would double-count a single wallet.
    if (dto.toWalletId === fromWalletId) {
      throw new BadRequestException('Cannot transfer to the same wallet');
    }

    // Ownership of the SOURCE only — the destination belongs to someone else, which is
    // the entire point of a transfer. Done before the transaction opens (M4a's lesson:
    // no unrelated I/O while holding a lock); ownership cannot change mid-request.
    await this.getOwnedWallet(fromWalletId, actor);

    const transferId = randomUUID();
    // Deterministic lock order. NOT sender-then-receiver: if it were, Alice->Bob and
    // Bob->Alice running concurrently would each hold the row the other needs, and
    // Postgres would kill one for deadlock. Sorted, both lock the same wallet first.
    const [firstLock, secondLock] = [fromWalletId, dto.toWalletId].sort();

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${firstLock} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${secondLock} FOR UPDATE`;

      // Re-read under the locks: these balances are the only ones we may trust.
      const from = await tx.wallet.findUnique({ where: { id: fromWalletId } });
      if (!from) throw new NotFoundException('Wallet not found');
      const to = await tx.wallet.findUnique({ where: { id: dto.toWalletId } });
      if (!to) throw new NotFoundException('Destination wallet not found');

      if (from.currency !== to.currency) {
        throw new BadRequestException('Wallets must share a currency'); // conversion is M4c
      }
      if (from.balance < dto.amount) throw new BadRequestException('Insufficient funds');

      const fromAfter = from.balance - dto.amount;
      const toAfter = to.balance + dto.amount;
      const settledAt = new Date();

      await tx.wallet.update({ where: { id: from.id }, data: { balance: fromAfter } });
      await tx.wallet.update({ where: { id: to.id }, data: { balance: toAfter } });

      // Both halves are settled at creation and credited to the sender: they initiated
      // the movement, and the receiver reviewed nothing.
      const shared = {
        transferId,
        amount: dto.amount,
        status: 'approved',
        requestedBy: actor.id,
        reviewedBy: actor.id,
        reviewedAt: settledAt,
        note: dto.note,
      };

      const outRow = await tx.transaction.create({
        data: {
          ...shared,
          walletId: from.id,
          type: 'transfer_out',
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
          counterpartyWalletId: from.id,
          balanceBefore: to.balance,
          balanceAfter: toAfter,
        },
      });

      // Only the sender's row is returned: the receiver's row carries their balance,
      // which the sender has no right to see.
      return outRow;
    });
  }
```

- [ ] **Step 4: Run the tests — green.**

```bash
cd backend && npm test -- wallets.service
```
Expected: **32 tests passing** in `wallets.service` (23 from M4a + 9).

- [ ] **Step 5: Full suite + typecheck.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; **7 suites / 61 tests**.

- [ ] **Step 6: Commit.**

```bash
git add backend/src/wallets
git commit -m "feat: add atomic wallet-to-wallet transfer with sorted two-wallet locking (Milestone 4b, Task 2)"
```

---

## Task 3: DTO, route, and the live concurrency proofs

**Files:**
- Create: `backend/src/wallets/dto/transfer.dto.ts`
- Modify: `backend/src/wallets/wallets.controller.ts`

**Interfaces:**
- Consumes: `WalletsService.transfer` (Task 2); `JwtAuthGuard` and `@CurrentUser` (M2).
- Produces: `POST /wallets/:id/transfers`.

- [ ] **Step 1: The DTO** at `backend/src/wallets/dto/transfer.dto.ts`:

```typescript
import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class TransferDto {
  // Validated as a UUID here so a malformed id fails at the boundary, not in the DB.
  @IsUUID()
  toWalletId!: string;

  // Minor units (cents). Positive integers only — direction comes from the route.
  @IsInt()
  @Min(1)
  amount!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
```

- [ ] **Step 2: The route.** In `backend/src/wallets/wallets.controller.ts`, add the import below the
      existing `AdjustmentDto` import:

```typescript
import { TransferDto } from './dto/transfer.dto';
```

Then add this method inside `WalletsController`, directly above the `adjust` method:

```typescript
  // Ownership-gated only, like the other customer routes: no permission is required to
  // move your own money. The destination is deliberately NOT ownership-checked.
  @Post(':id/transfers')
  transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: TransferDto,
  ) {
    return this.wallets.transfer(id, actor, dto);
  }
```

- [ ] **Step 3: Compile and test.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; **7 suites / 61 tests** (no new unit tests — the route is plumbing, proven by the
curls below).

- [ ] **Step 4: Set up two funded customers.** Start Postgres and the dev server first
      (`docker compose up -d` and `npm run start:dev` from `backend/`), then run this **as one block**
      — shell variables do not persist between separate command invocations.

```bash
cd /Users/max/Documents/GitHub/wallet-system
ADMIN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@wallet.local","password":"ChangeMe123!"}' | jq -r .accessToken)

for who in alice bob; do
  curl -s -o /dev/null -X POST http://localhost:3000/auth/register -H 'Content-Type: application/json' \
    -d "{\"email\":\"$who@m4b.test\",\"password\":\"Password123\",\"firstName\":\"$who\",\"lastName\":\"T\"}"
done

ALICE=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@m4b.test","password":"Password123"}' | jq -r .accessToken)
BOB=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"bob@m4b.test","password":"Password123"}' | jq -r .accessToken)

AW=$(curl -s -X POST http://localhost:3000/wallets -H "Authorization: Bearer $ALICE" \
  -H 'Content-Type: application/json' -d '{"name":"main","currency":"USD"}' | jq -r .id)
BW=$(curl -s -X POST http://localhost:3000/wallets -H "Authorization: Bearer $BOB" \
  -H 'Content-Type: application/json' -d '{"name":"main","currency":"USD"}' | jq -r .id)

for w in $AW $BW; do
  curl -s -o /dev/null -X POST "http://localhost:3000/wallets/$w/adjustments" \
    -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
    -d '{"direction":"credit","amount":100000,"note":"m4b test float"}'
done

echo "alice wallet=$AW  bob wallet=$BW"
```
Expected: two wallet ids printed, each wallet holding `100000`.

> **Shell variables do not survive between separate command invocations.** Every block below therefore
> re-derives them with the same four lines. Copy them verbatim into each block:
>
> ```bash
> ADMIN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
>   -d '{"email":"admin@wallet.local","password":"ChangeMe123!"}' | jq -r .accessToken)
> ALICE=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
>   -d '{"email":"alice@m4b.test","password":"Password123"}' | jq -r .accessToken)
> BOB=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
>   -d '{"email":"bob@m4b.test","password":"Password123"}' | jq -r .accessToken)
> AW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $ALICE" | jq -r '.[0].id')
> BW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $BOB" | jq -r '.[0].id')
> ```
>
> `.[0]` is stable: `listWallets` orders by `createdAt` ascending, so the "main" wallet stays first even
> after later steps create more.

- [ ] **Step 5: Happy path and the error cases.** Run as one block:

```bash
cd /Users/max/Documents/GitHub/wallet-system
ADMIN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@wallet.local","password":"ChangeMe123!"}' | jq -r .accessToken)
ALICE=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@m4b.test","password":"Password123"}' | jq -r .accessToken)
BOB=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"bob@m4b.test","password":"Password123"}' | jq -r .accessToken)
AW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $ALICE" | jq -r '.[0].id')
BW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $BOB" | jq -r '.[0].id')

echo "== alice -> bob, 2500 =="
curl -s -w '\n%{http_code}\n' -X POST "http://localhost:3000/wallets/$AW/transfers" \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d "{\"toWalletId\":\"$BW\",\"amount\":2500,\"note\":\"lunch\"}"

echo "== balances =="
curl -s "http://localhost:3000/wallets/$AW" -H "Authorization: Bearer $ALICE" | jq -c '{alice:.balance}'
curl -s "http://localhost:3000/wallets/$BW" -H "Authorization: Bearer $BOB" | jq -c '{bob:.balance}'

echo "== self-transfer (expect 400) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3000/wallets/$AW/transfers" \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d "{\"toWalletId\":\"$AW\",\"amount\":100}"

echo "== bob sending from alice's wallet (expect 403) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3000/wallets/$AW/transfers" \
  -H "Authorization: Bearer $BOB" -H 'Content-Type: application/json' \
  -d "{\"toWalletId\":\"$BW\",\"amount\":100}"

echo "== nonexistent destination (expect 404) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3000/wallets/$AW/transfers" \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d '{"toWalletId":"00000000-0000-0000-0000-000000000000","amount":100}'

echo "== cross-currency (expect 400) =="
EW=$(curl -s -X POST http://localhost:3000/wallets -H "Authorization: Bearer $BOB" \
  -H 'Content-Type: application/json' -d '{"name":"euro","currency":"EUR"}' | jq -r .id)
curl -s -w '\n%{http_code}\n' -X POST "http://localhost:3000/wallets/$AW/transfers" \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d "{\"toWalletId\":\"$EW\",\"amount\":100}"

echo "== alice's ledger (transfer_out only — no sight of bob's balance) =="
curl -s "http://localhost:3000/wallets/$AW/transactions" -H "Authorization: Bearer $ALICE" \
  | jq -c '.[0] | {type,amount,balanceBefore,balanceAfter,counterpartyWalletId,transferId}'
echo "== bob's ledger (the matching transfer_in, same transferId) =="
curl -s "http://localhost:3000/wallets/$BW/transactions" -H "Authorization: Bearer $BOB" \
  | jq -c '.[0] | {type,amount,balanceBefore,balanceAfter,counterpartyWalletId,transferId}'
```
Expected: transfer `201` returning a `transfer_out` row only; alice `97500`, bob `102500`; then
`400`, `403`, `404`, `400`. The two ledger rows share a `transferId`, point at each other via
`counterpartyWalletId`, and each shows its own unbroken chain.

- [ ] **Step 6: Proof 1 — no deadlock.** Alice→Bob and Bob→Alice fired simultaneously, 20 times, to
      widen the race window. With sender-first locking this produces `40P01 deadlock_detected` → `500`.

```bash
cd /Users/max/Documents/GitHub/wallet-system
ADMIN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@wallet.local","password":"ChangeMe123!"}' | jq -r .accessToken)
ALICE=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@m4b.test","password":"Password123"}' | jq -r .accessToken)
BOB=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"bob@m4b.test","password":"Password123"}' | jq -r .accessToken)
AW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $ALICE" | jq -r '.[0].id')
BW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $BOB" | jq -r '.[0].id')

for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST "http://localhost:3000/wallets/$AW/transfers" \
    -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
    -d "{\"toWalletId\":\"$BW\",\"amount\":100}" &
  curl -s -o /dev/null -w '%{http_code} ' -X POST "http://localhost:3000/wallets/$BW/transfers" \
    -H "Authorization: Bearer $BOB" -H 'Content-Type: application/json' \
    -d "{\"toWalletId\":\"$AW\",\"amount\":100}" &
  wait
done
echo
echo "== net effect should be zero: equal amounts crossed both ways =="
curl -s "http://localhost:3000/wallets/$AW" -H "Authorization: Bearer $ALICE" | jq -c '{alice:.balance}'
curl -s "http://localhost:3000/wallets/$BW" -H "Authorization: Bearer $BOB" | jq -c '{bob:.balance}'
```
Expected: **forty `201` codes and no `500`**. Balances identical to the end of Step 5 — alice `97500`,
bob `102500` — because each wallet sent 100 and received 100, twenty times over. Any `500` means the
lock order is wrong; check the Postgres log for `40P01 deadlock_detected` to confirm.

> **Why the loop.** A single simultaneous pair may not overlap at all — the race window is sub-millisecond.
> Twenty rounds make a genuine interleaving near-certain. This demonstrates the property rather than
> proving it; only the deferred integration harness could assert it in CI.

- [ ] **Step 7: Proof 2 — no double-spend.** One wallet funded for exactly one of two concurrent
      transfers.

```bash
cd /Users/max/Documents/GitHub/wallet-system
ADMIN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@wallet.local","password":"ChangeMe123!"}' | jq -r .accessToken)
ALICE=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@m4b.test","password":"Password123"}' | jq -r .accessToken)
BOB=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"bob@m4b.test","password":"Password123"}' | jq -r .accessToken)
AW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $ALICE" | jq -r '.[0].id')
BW=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $BOB" | jq -r '.[0].id')

# A fresh wallet holding exactly 5000, and a second destination.
CW=$(curl -s -X POST http://localhost:3000/wallets -H "Authorization: Bearer $ALICE" \
  -H 'Content-Type: application/json' -d '{"name":"drain","currency":"USD"}' | jq -r .id)
curl -s -o /dev/null -X POST "http://localhost:3000/wallets/$CW/adjustments" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"direction":"credit","amount":5000,"note":"race float"}'

echo "== two concurrent transfers of 5000 out of a wallet holding 5000 =="
curl -s -o /dev/null -w 'A:%{http_code} ' -X POST "http://localhost:3000/wallets/$CW/transfers" \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d "{\"toWalletId\":\"$BW\",\"amount\":5000}" &
curl -s -o /dev/null -w 'B:%{http_code}\n' -X POST "http://localhost:3000/wallets/$CW/transfers" \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d "{\"toWalletId\":\"$AW\",\"amount\":5000}" &
wait
curl -s "http://localhost:3000/wallets/$CW" -H "Authorization: Bearer $ALICE" | jq -c '{drained:.balance}'
```
Expected: exactly **one `201` and one `400`** (order varies), final balance **`0`** — never `-5000`.

> **Why `400` and not `409`:** M4a's settle-at-most-once guard does not apply. There is no shared pending
> row here — each transfer is an independent event, so the loser is not "settling one thing twice", it is
> "spending money that isn't there". The never-negative invariant catches it. Same lock, different
> invariant, different status code.

- [ ] **Step 8: Commit.**

```bash
git add backend/src/wallets
git commit -m "feat: add POST /wallets/:id/transfers (Milestone 4b, Task 3)"
```

---

## Task 4: Review, hardening, and learning notes

**Files:**
- Modify: `docs/learning-notes.md`
- Possibly modify: any file the review turns up

- [ ] **Step 1: Full verification.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; **7 suites / 61 tests** (52 from M4a + 9). If the count differs, find out why
before ticking this box.

- [ ] **Step 2: Boundary check** — `WalletsModule` must still be the only owner of those tables.

```bash
cd /Users/max/Documents/GitHub/wallet-system
grep -rn "prisma\.\(wallet\|transaction\)\." backend/src --include="*.ts" | grep -v ".spec.ts" | grep -v "src/wallets/"
```
Expected: **no output**. Any line printed is a leak to fix.

- [ ] **Step 3: Run the spec's checklist** (§12 of
      `../specs/2026-07-22-wallet-milestone-4b-transfers-design.md`) and tick each box:
  - [ ] No `prisma.wallet` / `prisma.transaction` access outside `WalletsModule`.
  - [ ] Both wallets are locked, in sorted-id order, before any balance is read.
  - [ ] The response never discloses the recipient's balance.
  - [ ] Both ledger rows always share a `transferId` and are written in one transaction.
  - [ ] Each wallet's `balanceBefore`/`balanceAfter` chain remains unbroken after a transfer.
  - [ ] A cross-currency transfer is refused, not silently converted.

- [ ] **Step 4: Read the diff with fresh eyes.** `git diff c992cf9..HEAD -- backend/`. Check: is the
      lock order sorted (not sender-first) in every path? Is the destination read **after** its lock?
      Does any response include the receiver's row? Is `amount` validated positive? Does the
      self-transfer check run before `$transaction` opens? Fix what you find; commit separately.

- [ ] **Step 5: Append the M4b sections to `docs/learning-notes.md`.** Cover, in plain English:
  - **Deterministic lock ordering** — the Alice→Bob / Bob→Alice cycle, why sender-first deadlocks and
    sorted ids cannot, that Postgres detects the cycle and kills a victim (`40P01`) rather than hanging,
    and why two separate `FOR UPDATE` statements beat `WHERE id IN (…) ORDER BY id`.
  - **Why this race yields `400`, not `409`** — the two invariants from M4a are independent; with no
    shared pending row, only never-negative applies.
  - **Double-entry in the ledger** — a movement has two halves; one row per wallet keeps every chain
    recomputable; the shared `transferId` proves they are one event.
  - **Asymmetric authorization** — ownership on the source, existence only on the destination, and why
    no new permission was needed.
  - **Response privacy** — returning only the sender's row, because the receiver's row carries their
    balance. Same instinct as `toSafeUser`: decide what *leaves*, not just what is stored.
  - **Deliberate non-goals** — FX (M4c), reversals, email lookup, limits/fraud rules, threshold
    approval, and allowing transfers into suspended-owner wallets (with the leak/holding rationale).

- [ ] **Step 6: Milestone recap section** in `docs/learning-notes.md`, following the M2/M3/M4a recap
      shape: the endpoint row for transfers added to a small table, the transfer lifecycle (validate →
      lock both in sorted order → re-read → verify → move both balances → write the linked pair), and the
      deferred list.

- [ ] **Step 7: Commit.**

```bash
git add docs/learning-notes.md
git commit -m "docs: consolidate Milestone 4b learning notes (Milestone 4b, Task 4)"
```

- [ ] **Step 8: Update the project memory** at
      `/Users/max/.claude/projects/-Users-max-Documents-GitHub-wallet-system/memory/wallet-system-project.md`:
      mark M4b complete with its commit range and per-task ✅ list, and set
      `⏭ NEXT: Milestone 4c (FX conversion)`. Update the `MEMORY.md` index line accordingly.

---

## Milestone 4b self-review checklist (run before starting Milestone 4c)

- [ ] `npm test` green (61 tests); `npx tsc --noEmit` clean.
- [ ] Clean commits, one per task.
- [ ] Both live proofs reproduced: 40 concurrent crossing transfers with no `500`; two concurrent
      drains yielding one `201` and one `400` with a final balance of `0`.
- [ ] **You can explain:** why sorting the ids prevents deadlock where sender-first does not; why this
      race produces `400` and not `409`; why the destination is not ownership-checked; and why the
      receiver's row is withheld from the response.

---

## What Milestone 4c will cover (preview, not yet detailed)

Currency conversion: the same two-wallet locked transfer, but the credited amount differs from the
debited amount by an exchange rate. New questions it forces — where the rate comes from and how it is
stored for audit (a rate must be recorded on the transaction, not looked up again later), how rounding
is handled so no money is created or destroyed, and whether the spread is captured as a fee row.
