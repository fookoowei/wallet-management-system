# Milestone 4a — Core Wallet + Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking. Implements `../specs/2026-07-21-wallet-milestone-4a-core-ledger-design.md`.

**Goal:** A working, auditable ledger — customers request deposits/withdrawals, a `finance` user
approves, and approval settles the wallet balance atomically and exactly once, recording a
self-verifiable `Transaction` row.

**Architecture:** A new `WalletsModule` is the sole owner of `prisma.wallet` and `prisma.transaction`.
`WalletsService` holds all logic; `WalletsController` serves customer routes (ownership-gated in the
service), `TransactionsController` serves finance routes (permission-gated). Settlement runs inside a
Prisma interactive transaction using pessimistic row locks (`SELECT ... FOR UPDATE` via `$queryRaw`),
protecting two invariants: a request settles at most once (else `409`), and a balance never goes
negative (else `400`).

**Tech Stack:** NestJS 11, Prisma 6 (`prisma-client-js`), PostgreSQL 16, Jest, class-validator +
class-transformer.

## Global Constraints

- **Money is integer minor units** (cents) everywhere. No floats, ever. `amount` is always **positive**;
  `type` (`deposit`/`withdrawal`/`adjustment`) carries direction.
- **A balance must never go below 0.** Withdrawals and debit-adjustments enforce this.
- **Settlement is atomic and uses pessimistic locking**: one `prisma.$transaction(async (tx) => …)`,
  with `SELECT ... FOR UPDATE` issued via `tx.$queryRaw`. **Fixed lock order: transaction row, then
  wallet row** (matters for M4c when two wallets lock).
- `401` = identity unknown (`JwtAuthGuard`). `403` = known but refused (ownership OR permission).
  `404` = not found. `400` = bad amount / insufficient funds. `409` = settling a non-`pending` row.
- **Ownership-gating** (customer routes) is a **service-layer** check (`wallet.userId === actor.id`).
  **Permission-gating** (finance routes) uses M3's `PermissionsGuard` + `@RequirePermissions`. The
  **type-specific** approve permission (`deposit.approve` vs `withdrawal.approve`) is checked in the
  **service**, because it depends on the loaded row's `type` (same reasoning as M3's SoD rules).
- `PrismaModule` is `@Global()` — do not import it. `WalletsModule` imports `UsersModule` (to reach
  `UsersService.findByIdWithPermissions` for the type-specific check).
- Any type used in a **decorated signature** must use `import type` (TS1272). `AuthUser` is such a type.
- `WalletsModule` is the **only** place `prisma.wallet` / `prisma.transaction` are touched.
- `npx tsc --noEmit` and `npm test` (run from `backend/`) are the source of truth, not editor squiggles.
- One conventional commit per task. The user pushes.

---

## File structure created in this milestone

```
backend/
├── prisma/
│   └── schema.prisma                 # MODIFIED: + Wallet, Transaction models; User gets wallets[]
└── src/
    ├── app.module.ts                 # MODIFIED: register WalletsModule
    └── wallets/
        ├── wallets.module.ts         # NEW: owns prisma.wallet + prisma.transaction
        ├── wallets.service.ts        # NEW: all wallet/ledger logic
        ├── wallets.service.spec.ts   # NEW: TDD
        ├── wallets.controller.ts     # NEW: customer routes (/wallets…) + finance adjustment
        ├── transactions.controller.ts# NEW: finance routes (/transactions…)
        └── dto/
            ├── create-wallet.dto.ts  # NEW
            ├── money-amount.dto.ts   # NEW: { amount, note? } for deposit/withdrawal requests
            ├── adjustment.dto.ts     # NEW: { direction, amount, note }
            └── reject.dto.ts         # NEW: { note? }
```

---

## Task 1: Schema + migration + `WalletsModule` skeleton

**Files:**
- Modify: `backend/prisma/schema.prisma`, `backend/src/app.module.ts`
- Create: `backend/src/wallets/wallets.service.ts`, `backend/src/wallets/wallets.module.ts`

**Interfaces:**
- Produces: `Wallet` + `Transaction` Prisma models; `WalletsService` (empty shell for now);
  `WalletsModule`.

- [ ] **Step 1: Baseline green.** A schema change is safest from a clean, passing state.

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; 6 suites, 29 tests passing (M3 end state).

- [ ] **Step 2: Add the models** to `backend/prisma/schema.prisma`. Append these two models and add the
      back-relation line to `User`.

Add inside the existing `model User { … }` block (anywhere among its fields):
```prisma
  wallets      Wallet[]
```

Append at the end of the file:
```prisma
model Wallet {
  id           String        @id @default(uuid())
  user         User          @relation(fields: [userId], references: [id])
  userId       String
  name         String
  currency     String        // ISO code, e.g. "USD"; fixed per wallet (FX is M4d)
  balance      Int           @default(0) // minor units; invariant: never < 0
  transactions Transaction[]
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  @@index([userId])
}

model Transaction {
  id            String    @id @default(uuid())
  wallet        Wallet    @relation(fields: [walletId], references: [id])
  walletId      String
  type          String    // deposit | withdrawal | adjustment
  amount        Int       // minor units, always positive; type carries direction
  balanceBefore Int?      // null while pending; set at settlement
  balanceAfter  Int?      // null while pending; set at settlement
  status        String    @default("pending") // pending | approved | rejected
  requestedBy   String    // userId (plain string; no FK — see plan note)
  reviewedBy    String?   // userId of the finance approver; null while pending
  reviewedAt    DateTime?
  note          String?
  createdAt     DateTime  @default(now())

  @@index([walletId])
  @@index([status])
}
```

> **Note (deliberate):** `requestedBy` / `reviewedBy` are plain `String` userIds, not FK relations.
> Adding relations would require two named relations plus back-references on `User` for a query M4a never
> runs ("transactions by requester"). YAGNI — keep them as ids. Revisit if a later phase needs the join.

- [ ] **Step 3: Generate the migration.** Postgres must be up (`docker compose ps`). This also
      regenerates the typed client.

```bash
cd backend && npm run prisma:migrate -- --name add_wallets_and_transactions
```
Expected: a new folder under `prisma/migrations/…_add_wallets_and_transactions`, and
"Your database is now in sync with your schema." If it prompts to reset, **stop** — you have unmigrated
drift; investigate rather than resetting (the dev DB holds the M3 test users).

- [ ] **Step 4: The empty service** at `backend/src/wallets/wallets.service.ts`. A shell so the module
      boots; methods arrive in later tasks.

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}
}
```

- [ ] **Step 5: The module** at `backend/src/wallets/wallets.module.ts`. Imports `UsersModule` (for the
      type-specific permission check later); no `imports` of `PrismaModule` (it is `@Global`).

```typescript
import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WalletsService } from './wallets.service';

@Module({
  imports: [UsersModule],
  providers: [WalletsService],
})
export class WalletsModule {}
```

- [ ] **Step 6: Register it** in `backend/src/app.module.ts`. Add the import and put `WalletsModule` in
      the `imports` array after `UsersModule`.

```typescript
import { WalletsModule } from './wallets/wallets.module';
```
and in `@Module({ imports: [ … ] })`, after `UsersModule,`:
```typescript
    WalletsModule,
```

- [ ] **Step 7: Verify it compiles and boots.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; still 6 suites / 29 tests (no new tests yet — this is scaffolding). The typed
Prisma client now knows `prisma.wallet` and `prisma.transaction`.

- [ ] **Step 8: Commit.**

```bash
git add backend/prisma backend/src/wallets backend/src/app.module.ts
git commit -m "feat: add Wallet and Transaction models + WalletsModule skeleton (Milestone 4a, Task 1)"
```

---

## Task 2: Wallet creation, reads, and ownership-gating — TDD

**Files:**
- Modify: `backend/src/wallets/wallets.service.ts`, `backend/src/wallets/wallets.module.ts`
- Create: `backend/src/wallets/wallets.service.spec.ts`,
  `backend/src/wallets/wallets.controller.ts`, `backend/src/wallets/dto/create-wallet.dto.ts`

**Interfaces:**
- Consumes: `PrismaService`, `UsersService` (Task 1); `AuthUser` (M2); `JwtAuthGuard` (M2),
  `@CurrentUser` (M2).
- Produces: `WalletsService.createWallet(actor, {name, currency})`,
  `WalletsService.listWallets(actor)`, `WalletsService.getWallet(id, actor)`,
  `WalletsService.listTransactions(id, actor)`, and the private `getOwnedWallet(id, actor)` used by
  later tasks (404 if missing, 403 if not owned, else the wallet).

- [ ] **Step 1: Write the failing tests** at `backend/src/wallets/wallets.service.spec.ts`.

```typescript
import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import type { AuthUser } from '../auth/jwt.strategy';

const actor: AuthUser = { id: 'user-1', email: 'u1@example.com', role: 'user' };
const other: AuthUser = { id: 'user-2', email: 'u2@example.com', role: 'user' };

function buildService(
  prismaMock: any,
  usersMock: any = { findByIdWithPermissions: jest.fn() },
) {
  return Test.createTestingModule({
    providers: [
      WalletsService,
      { provide: PrismaService, useValue: prismaMock },
      { provide: UsersService, useValue: usersMock },
    ],
  })
    .compile()
    .then((moduleRef) => moduleRef.get(WalletsService));
}

const wallet = (over: Partial<any> = {}) => ({
  id: 'wallet-1',
  userId: 'user-1',
  name: 'main',
  currency: 'USD',
  balance: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('WalletsService.createWallet', () => {
  it('creates a wallet owned by the actor', async () => {
    const prismaMock = { wallet: { create: jest.fn().mockResolvedValue(wallet()) } };
    const service = await buildService(prismaMock);

    await service.createWallet(actor, { name: 'main', currency: 'USD' });

    expect(prismaMock.wallet.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', name: 'main', currency: 'USD' }),
      }),
    );
  });
});

describe('WalletsService.listWallets', () => {
  it('returns only the actor’s wallets', async () => {
    const prismaMock = { wallet: { findMany: jest.fn().mockResolvedValue([wallet()]) } };
    const service = await buildService(prismaMock);

    await service.listWallets(actor);

    expect(prismaMock.wallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });
});

describe('WalletsService.getWallet (ownership)', () => {
  it('returns the wallet when the actor owns it', async () => {
    const prismaMock = { wallet: { findUnique: jest.fn().mockResolvedValue(wallet()) } };
    const service = await buildService(prismaMock);

    const result = await service.getWallet('wallet-1', actor);

    expect(result.id).toBe('wallet-1');
  });

  it('throws NotFoundException when the wallet does not exist', async () => {
    const prismaMock = { wallet: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = await buildService(prismaMock);

    await expect(service.getWallet('ghost', actor)).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when the wallet belongs to someone else', async () => {
    const prismaMock = { wallet: { findUnique: jest.fn().mockResolvedValue(wallet()) } };
    const service = await buildService(prismaMock);

    await expect(service.getWallet('wallet-1', other)).rejects.toThrow(ForbiddenException);
  });
});

describe('WalletsService.listTransactions (ownership)', () => {
  it('lists a wallet’s transactions for the owner', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet()) },
      transaction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = await buildService(prismaMock);

    await service.listTransactions('wallet-1', actor);

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: 'wallet-1' } }),
    );
  });

  it('refuses a non-owner before reading transactions', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet()) },
      transaction: { findMany: jest.fn() },
    };
    const service = await buildService(prismaMock);

    await expect(service.listTransactions('wallet-1', other)).rejects.toThrow(ForbiddenException);
    expect(prismaMock.transaction.findMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

```bash
cd backend && npm test -- wallets.service
```
Expected: FAIL — `service.createWallet is not a function`.

- [ ] **Step 3: Implement the methods.** Replace `backend/src/wallets/wallets.service.ts` with:

```typescript
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import type { AuthUser } from '../auth/jwt.strategy';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  createWallet(actor: AuthUser, dto: { name: string; currency: string }) {
    return this.prisma.wallet.create({
      data: { userId: actor.id, name: dto.name, currency: dto.currency },
    });
  }

  listWallets(actor: AuthUser) {
    return this.prisma.wallet.findMany({
      where: { userId: actor.id },
      orderBy: { createdAt: 'asc' },
    });
  }

  getWallet(id: string, actor: AuthUser) {
    return this.getOwnedWallet(id, actor);
  }

  async listTransactions(id: string, actor: AuthUser) {
    await this.getOwnedWallet(id, actor); // 404 if missing, 403 if not owned
    return this.prisma.transaction.findMany({
      where: { walletId: id },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Ownership-gating: load a wallet and confirm the caller owns it.
   * The check lives here (not a guard) because it depends on the loaded row.
   */
  private async getOwnedWallet(id: string, actor: AuthUser) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (wallet.userId !== actor.id) throw new ForbiddenException('Access denied');
    return wallet;
  }
}
```

- [ ] **Step 4: Run the tests — green.**

```bash
cd backend && npm test -- wallets.service
```
Expected: 7 tests passing.

- [ ] **Step 5: The DTO** at `backend/src/wallets/dto/create-wallet.dto.ts`:

```typescript
import { IsString, Length, MinLength } from 'class-validator';

export class CreateWalletDto {
  @IsString()
  @MinLength(1)
  name!: string;

  // ISO 4217 code, e.g. "USD". Fixed per wallet; conversion is M4d.
  @IsString()
  @Length(3, 3)
  currency!: string;
}
```

- [ ] **Step 6: The customer controller** at `backend/src/wallets/wallets.controller.ts`. Guarded by
      `JwtAuthGuard` only — there is no *permission* to hold; ownership is enforced in the service.
      (The finance-only adjustment route is added to this controller in Task 5.)

```typescript
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';

@Controller('wallets')
@UseGuards(JwtAuthGuard)
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateWalletDto) {
    return this.wallets.createWallet(actor, dto);
  }

  @Get()
  list(@CurrentUser() actor: AuthUser) {
    return this.wallets.listWallets(actor);
  }

  @Get(':id')
  getOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.wallets.getWallet(id, actor);
  }

  @Get(':id/transactions')
  listTransactions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.wallets.listTransactions(id, actor);
  }
}
```

- [ ] **Step 7: Register the controller** in `backend/src/wallets/wallets.module.ts` — add
      `controllers: [WalletsController]` (import it at the top):

```typescript
import { WalletsController } from './wallets.controller';
```
and in `@Module({ … })`:
```typescript
  controllers: [WalletsController],
```

- [ ] **Step 8: Verify — compile, test, and a quick end-to-end.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; 7 suites / 36 tests (29 + 7).

With the server running (`npm run start:dev`) and Postgres up:
```bash
CUSTOMER=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"refactor-check@example.com","password":"Password123"}' | jq -r .accessToken)

curl -s -w '\n%{http_code}\n' -X POST http://localhost:3000/wallets \
  -H "Authorization: Bearer $CUSTOMER" -H 'Content-Type: application/json' \
  -d '{"name":"main","currency":"USD"}'
curl -s -w '\n%{http_code}\n' http://localhost:3000/wallets -H "Authorization: Bearer $CUSTOMER"
```
Expected: `201` with a wallet (`balance: 0`), then `200` with a list containing it.

- [ ] **Step 9: Commit.**

```bash
git add backend/src/wallets
git commit -m "feat: add wallet creation, reads, and ownership-gating (Milestone 4a, Task 2)"
```

---

## Task 3: Deposit & withdrawal requests — TDD

**Files:**
- Modify: `backend/src/wallets/wallets.service.ts`, `backend/src/wallets/wallets.controller.ts`
- Create: `backend/src/wallets/dto/money-amount.dto.ts`
- Test: append to `backend/src/wallets/wallets.service.spec.ts`

**Interfaces:**
- Consumes: `getOwnedWallet` (Task 2).
- Produces: `WalletsService.requestDeposit(id, actor, amount, note?)`,
  `WalletsService.requestWithdrawal(id, actor, amount, note?)` — each returns a `pending` transaction.

- [ ] **Step 1: Write the failing tests.** First widen the top-of-file `@nestjs/common` import in
      `wallets.service.spec.ts` to add `BadRequestException`:

```typescript
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
```
Then append these tests:

```typescript
describe('WalletsService.requestDeposit', () => {
  it('creates a pending deposit and changes no balance', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet({ balance: 500 })) },
      transaction: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) },
    };
    const service = await buildService(prismaMock);

    const result = await service.requestDeposit('wallet-1', actor, 1000, 'salary');

    expect(prismaMock.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          walletId: 'wallet-1', type: 'deposit', amount: 1000, status: 'pending', requestedBy: 'user-1',
        }),
      }),
    );
    expect(result.balanceBefore).toBeUndefined(); // pending rows carry no settled balance
  });

  it('refuses to deposit into a wallet the actor does not own', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet()) },
      transaction: { create: jest.fn() },
    };
    const service = await buildService(prismaMock);

    await expect(service.requestDeposit('wallet-1', other, 1000)).rejects.toThrow(ForbiddenException);
    expect(prismaMock.transaction.create).not.toHaveBeenCalled();
  });
});

describe('WalletsService.requestWithdrawal', () => {
  it('creates a pending withdrawal when funds appear sufficient', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })) },
      transaction: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) },
    };
    const service = await buildService(prismaMock);

    await service.requestWithdrawal('wallet-1', actor, 2000);

    expect(prismaMock.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'withdrawal', amount: 2000, status: 'pending' }),
      }),
    );
  });

  it('rejects an obviously-insufficient withdrawal request early (friendly 400)', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet({ balance: 100 })) },
      transaction: { create: jest.fn() },
    };
    const service = await buildService(prismaMock);

    await expect(service.requestWithdrawal('wallet-1', actor, 2000)).rejects.toThrow(BadRequestException);
    expect(prismaMock.transaction.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

```bash
cd backend && npm test -- wallets.service
```
Expected: FAIL — `service.requestDeposit is not a function`.

- [ ] **Step 3: Implement.** Add `BadRequestException` to the `@nestjs/common` import in
      `wallets.service.ts`, then add these two methods to `WalletsService`:

```typescript
  async requestDeposit(id: string, actor: AuthUser, amount: number, note?: string) {
    await this.getOwnedWallet(id, actor);
    return this.prisma.transaction.create({
      data: { walletId: id, type: 'deposit', amount, status: 'pending', requestedBy: actor.id, note },
    });
  }

  async requestWithdrawal(id: string, actor: AuthUser, amount: number, note?: string) {
    const wallet = await this.getOwnedWallet(id, actor);
    // Friendly, NON-authoritative pre-check: fail obvious cases early so a customer
    // isn't left with a doomed pending request. The authoritative check is at approval
    // (the balance can change between request and approval).
    if (wallet.balance < amount) throw new BadRequestException('Insufficient funds');
    return this.prisma.transaction.create({
      data: { walletId: id, type: 'withdrawal', amount, status: 'pending', requestedBy: actor.id, note },
    });
  }
```

- [ ] **Step 4: Run the tests — green.**

```bash
cd backend && npm test -- wallets.service
```
Expected: 11 tests passing (7 + 4).

- [ ] **Step 5: The DTO** at `backend/src/wallets/dto/money-amount.dto.ts`:

```typescript
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class MoneyAmountDto {
  // Minor units (cents). Positive integers only — direction comes from the route, not a sign.
  @IsInt()
  @Min(1)
  amount!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
```

- [ ] **Step 6: The routes.** In `backend/src/wallets/wallets.controller.ts`, import the DTO and add two
      routes:

```typescript
import { MoneyAmountDto } from './dto/money-amount.dto';
```
inside `WalletsController`:
```typescript
  @Post(':id/deposits')
  requestDeposit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: MoneyAmountDto,
  ) {
    return this.wallets.requestDeposit(id, actor, dto.amount, dto.note);
  }

  @Post(':id/withdrawals')
  requestWithdrawal(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: MoneyAmountDto,
  ) {
    return this.wallets.requestWithdrawal(id, actor, dto.amount, dto.note);
  }
```

- [ ] **Step 7: Verify — compile, test, end-to-end.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; 7 suites / 40 tests (36 + 4).

With server + Postgres up (reuse `$CUSTOMER` and a wallet id from Task 2; capture it):
```bash
WALLET=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $CUSTOMER" | jq -r '.[0].id')
curl -s -w '\n%{http_code}\n' -X POST "http://localhost:3000/wallets/$WALLET/deposits" \
  -H "Authorization: Bearer $CUSTOMER" -H 'Content-Type: application/json' -d '{"amount":10000,"note":"first deposit"}'
```
Expected: `201`, a `pending` deposit for `10000`, `balanceBefore`/`balanceAfter` null.

- [ ] **Step 8: Commit.**

```bash
git add backend/src/wallets
git commit -m "feat: add deposit and withdrawal requests (Milestone 4a, Task 3)"
```

---

## Task 4: Settlement — approve/reject with pessimistic locking — TDD

**This is the milestone's core.** Two invariants (§6 of the spec): settle-at-most-once (`409`) and
never-negative (`400`), enforced under row locks inside one DB transaction.

**Files:**
- Modify: `backend/src/wallets/wallets.service.ts`, `backend/src/wallets/wallets.module.ts`
- Create: `backend/src/wallets/transactions.controller.ts`, `backend/src/wallets/dto/reject.dto.ts`
- Test: append to `backend/src/wallets/wallets.service.spec.ts`

**Interfaces:**
- Consumes: `UsersService.findByIdWithPermissions` (Task 1 / M3); `PermissionsGuard`,
  `@RequirePermissions` (M3).
- Produces: `WalletsService.listPending()`, `WalletsService.approve(txnId, actor)`,
  `WalletsService.reject(txnId, actor, note?)`, private `assertApprovePermission(actor, type)`.

- [ ] **Step 1: Write the failing tests.** Append to `backend/src/wallets/wallets.service.spec.ts`. The
      key trick: mock `prisma.$transaction` to invoke its callback with a `tx` mock, so the locked flow
      runs against fakes. `$queryRaw` (the lock) is a no-op that resolves.

First widen the top-of-file `@nestjs/common` import in `wallets.service.spec.ts` to add
`ConflictException` (`BadRequestException` was added in Task 3):
```typescript
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
```
Then append these tests:

```typescript
const finance: AuthUser = { id: 'fin-1', email: 'fin@wallet.local', role: 'finance' };

// A finance user holding both approve permissions, as findByIdWithPermissions returns them.
const financeCanApprove = {
  findByIdWithPermissions: jest.fn().mockResolvedValue({
    id: 'fin-1',
    status: 'active',
    role: { permissions: [{ code: 'deposit.approve' }, { code: 'withdrawal.approve' }] },
  }),
};

const pendingTxn = (over: Partial<any> = {}) => ({
  id: 'txn-1',
  walletId: 'wallet-1',
  type: 'withdrawal',
  amount: 2000,
  status: 'pending',
  requestedBy: 'user-1',
  balanceBefore: null,
  balanceAfter: null,
  ...over,
});

// Build a prisma mock whose $transaction runs the callback against a tx double.
function txPrisma(txDouble: any, extra: any = {}) {
  return {
    $transaction: jest.fn().mockImplementation((cb: any) => cb(txDouble)),
    ...extra,
  };
}

describe('WalletsService.approve', () => {
  it('settles a withdrawal atomically and records the balance chain', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn()),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'txn-1', ...data })),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    const result = await service.approve('txn-1', finance);

    expect(txDouble.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wallet-1' }, data: { balance: 3000 } }),
    );
    expect(result.status).toBe('approved');
    expect(result.balanceBefore).toBe(5000);
    expect(result.balanceAfter).toBe(3000);
    expect(result.reviewedBy).toBe('fin-1');
  });

  it('settles a deposit by increasing the balance', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn({ type: 'deposit', amount: 1000 })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'txn-1', ...data })),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    const result = await service.approve('txn-1', finance);

    expect(result.balanceAfter).toBe(6000);
  });

  it('rejects an over-balance withdrawal with 400 and moves no money', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn({ amount: 9000 })),
        update: jest.fn(),
      },
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })), update: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    await expect(service.approve('txn-1', finance)).rejects.toThrow(BadRequestException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
    expect(txDouble.transaction.update).not.toHaveBeenCalled();
  });

  it('refuses to settle a non-pending request with 409 (double-approval guard)', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn({ status: 'approved' })),
        update: jest.fn(),
      },
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    await expect(service.approve('txn-1', finance)).rejects.toThrow(ConflictException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
  });

  it('throws 404 when the transaction does not exist', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    await expect(service.approve('ghost', finance)).rejects.toThrow(NotFoundException);
  });

  it('forbids an actor lacking the type-specific approve permission (403)', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: { findUnique: jest.fn().mockResolvedValue(pendingTxn()), update: jest.fn() },
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    // Holds deposit.approve but NOT withdrawal.approve; the txn is a withdrawal.
    const usersMock = {
      findByIdWithPermissions: jest.fn().mockResolvedValue({
        id: 'fin-1', status: 'active', role: { permissions: [{ code: 'deposit.approve' }] },
      }),
    };
    const service = await buildService(txPrisma(txDouble), usersMock);

    await expect(service.approve('txn-1', finance)).rejects.toThrow(ForbiddenException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
  });
});

describe('WalletsService.reject', () => {
  it('marks a pending request rejected without touching the balance', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn()),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'txn-1', ...data })),
      },
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    const result = await service.reject('txn-1', finance, 'suspicious');

    expect(result.status).toBe('rejected');
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
  });

  it('refuses to reject a non-pending request with 409', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn({ status: 'rejected' })),
        update: jest.fn(),
      },
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    await expect(service.reject('txn-1', finance)).rejects.toThrow(ConflictException);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

```bash
cd backend && npm test -- wallets.service
```
Expected: FAIL — `service.approve is not a function`.

- [ ] **Step 3: Implement settlement.** In `wallets.service.ts`, add `ConflictException` to the
      `@nestjs/common` import, then add these methods to `WalletsService`:

```typescript
  listPending() {
    return this.prisma.transaction.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
  }

  async approve(txnId: string, actor: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      // Lock the transaction row first (fixed order: txn, then wallet).
      await tx.$queryRaw`SELECT id FROM "Transaction" WHERE id = ${txnId} FOR UPDATE`;
      const txn = await tx.transaction.findUnique({ where: { id: txnId } });
      if (!txn) throw new NotFoundException('Transaction not found');
      if (txn.status !== 'pending') throw new ConflictException('Transaction already reviewed');

      // Type-specific permission — depends on the loaded row's type (like M3's SoD checks).
      await this.assertApprovePermission(actor, txn.type);

      // Lock the wallet row, then read its true current balance.
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${txn.walletId} FOR UPDATE`;
      const wallet = await tx.wallet.findUnique({ where: { id: txn.walletId } });
      if (!wallet) throw new NotFoundException('Wallet not found');

      const before = wallet.balance;
      let after: number;
      if (txn.type === 'withdrawal') {
        if (before < txn.amount) throw new BadRequestException('Insufficient funds');
        after = before - txn.amount;
      } else {
        after = before + txn.amount; // deposit
      }

      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: after } });
      return tx.transaction.update({
        where: { id: txn.id },
        data: {
          status: 'approved',
          reviewedBy: actor.id,
          reviewedAt: new Date(),
          balanceBefore: before,
          balanceAfter: after,
        },
      });
    });
  }

  async reject(txnId: string, actor: AuthUser, note?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Transaction" WHERE id = ${txnId} FOR UPDATE`;
      const txn = await tx.transaction.findUnique({ where: { id: txnId } });
      if (!txn) throw new NotFoundException('Transaction not found');
      if (txn.status !== 'pending') throw new ConflictException('Transaction already reviewed');

      await this.assertApprovePermission(actor, txn.type);

      return tx.transaction.update({
        where: { id: txn.id },
        data: {
          status: 'rejected',
          reviewedBy: actor.id,
          reviewedAt: new Date(),
          note: note ?? txn.note,
        },
      });
    });
  }

  /**
   * Approving a deposit needs deposit.approve; a withdrawal needs withdrawal.approve.
   * Which one is required depends on the row's type, so the check is here, not in a
   * static route guard. Permissions are read from the DB (never the token) — M3's rule.
   */
  private async assertApprovePermission(actor: AuthUser, type: string) {
    const code = type === 'withdrawal' ? 'withdrawal.approve' : 'deposit.approve';
    const user = await this.users.findByIdWithPermissions(actor.id);
    const held = new Set(user?.role.permissions.map((permission) => permission.code) ?? []);
    if (!held.has(code)) throw new ForbiddenException('Access denied');
  }
```

- [ ] **Step 4: Run the tests — green.**

```bash
cd backend && npm test -- wallets.service
```
Expected: 19 tests passing (11 + 8).

- [ ] **Step 5: The reject DTO** at `backend/src/wallets/dto/reject.dto.ts`:

```typescript
import { IsOptional, IsString } from 'class-validator';

export class RejectDto {
  @IsOptional()
  @IsString()
  note?: string;
}
```

- [ ] **Step 6: The finance controller** at `backend/src/wallets/transactions.controller.ts`. Class-level
      `PermissionsGuard` + `transaction.view_all` is the coarse gate (finance/admin/support can view);
      the *type-specific* approve permission is enforced in the service. `finance` holds
      `transaction.view_all` **and** both approve permissions; `admin` holds `transaction.view_all` but
      not the approve permissions, so an admin can list pending yet gets `403` on approve — correct
      separation.

```typescript
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { WalletsService } from './wallets.service';
import { RejectDto } from './dto/reject.dto';

@Controller('transactions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('transaction.view_all')
export class TransactionsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get('pending')
  pending() {
    return this.wallets.listPending();
  }

  @Post(':id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.wallets.approve(id, actor);
  }

  @Post(':id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: RejectDto,
  ) {
    return this.wallets.reject(id, actor, dto.note);
  }
}
```

- [ ] **Step 7: Register the controller** in `backend/src/wallets/wallets.module.ts` — import it and add
      to `controllers`:

```typescript
import { TransactionsController } from './transactions.controller';
```
```typescript
  controllers: [WalletsController, TransactionsController],
```

- [ ] **Step 8: Verify — compile, test, then prove the flow AND the race end-to-end.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; 7 suites / 48 tests (40 + 8).

With server + Postgres up. First the happy path:
```bash
ADMIN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@wallet.local","password":"ChangeMe123!"}' | jq -r .accessToken)
CUSTOMER=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"refactor-check@example.com","password":"Password123"}' | jq -r .accessToken)
WALLET=$(curl -s http://localhost:3000/wallets -H "Authorization: Bearer $CUSTOMER" | jq -r '.[0].id')

# The seeded admin is super_admin (holds every permission incl. both approves) — it can settle.
DEP=$(curl -s -X POST "http://localhost:3000/wallets/$WALLET/deposits" -H "Authorization: Bearer $CUSTOMER" \
  -H 'Content-Type: application/json' -d '{"amount":10000}' | jq -r .id)
curl -s -w '\n%{http_code}\n' -X POST "http://localhost:3000/transactions/$DEP/approve" -H "Authorization: Bearer $ADMIN"
curl -s http://localhost:3000/wallets/$WALLET -H "Authorization: Bearer $CUSTOMER" | jq '{balance}'
```
Expected: approve → `200`, txn `approved` with `balanceBefore:0`, `balanceAfter:10000`; wallet balance now `10000`.

Now **the race** — one pending withdrawal, two concurrent approvals, exactly one wins:
```bash
WD=$(curl -s -X POST "http://localhost:3000/wallets/$WALLET/withdrawals" -H "Authorization: Bearer $CUSTOMER" \
  -H 'Content-Type: application/json' -d '{"amount":10000}' | jq -r .id)

# Fire two approvals at once; print only the HTTP codes.
curl -s -o /dev/null -w 'A:%{http_code} ' -X POST "http://localhost:3000/transactions/$WD/approve" -H "Authorization: Bearer $ADMIN" &
curl -s -o /dev/null -w 'B:%{http_code}\n' -X POST "http://localhost:3000/transactions/$WD/approve" -H "Authorization: Bearer $ADMIN" &
wait
curl -s http://localhost:3000/wallets/$WALLET -H "Authorization: Bearer $CUSTOMER" | jq '{balance}'
```
Expected: exactly **one `200` and one `409`** (order varies), and the wallet debited **once** →
`balance: 0`. That is the two invariants proven on real Postgres. (A full jest integration harness with
a dedicated test DB is deferred; this concurrent-curl demo is the real-DB proof for M4a.)

- [ ] **Step 9: Commit.**

```bash
git add backend/src/wallets
git commit -m "feat: add atomic approve/reject settlement with pessimistic locking (Milestone 4a, Task 4)"
```

---

## Task 5: Direct adjustments — TDD

**Files:**
- Modify: `backend/src/wallets/wallets.service.ts`, `backend/src/wallets/wallets.controller.ts`
- Create: `backend/src/wallets/dto/adjustment.dto.ts`
- Test: append to `backend/src/wallets/wallets.service.spec.ts`

**Interfaces:**
- Produces: `WalletsService.adjust(walletId, {direction, amount, note}, actor)` — a settled `adjustment`
  transaction, no pending stage.

- [ ] **Step 1: Write the failing tests.** Append to `backend/src/wallets/wallets.service.spec.ts`:

```typescript
describe('WalletsService.adjust', () => {
  it('credits a wallet and writes a settled adjustment row', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })),
        update: jest.fn().mockResolvedValue(undefined),
      },
      transaction: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'adj-1', ...data })),
      },
    };
    const service = await buildService(txPrisma(txDouble));

    const result = await service.adjust('wallet-1', { direction: 'credit', amount: 1000, note: 'bonus' }, finance);

    expect(txDouble.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wallet-1' }, data: { balance: 6000 } }),
    );
    expect(result.type).toBe('adjustment');
    expect(result.status).toBe('approved');
    expect(result.balanceBefore).toBe(5000);
    expect(result.balanceAfter).toBe(6000);
  });

  it('debits a wallet', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })),
        update: jest.fn().mockResolvedValue(undefined),
      },
      transaction: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'adj-1', ...data })),
      },
    };
    const service = await buildService(txPrisma(txDouble));

    const result = await service.adjust('wallet-1', { direction: 'debit', amount: 2000, note: 'correction' }, finance);

    expect(result.balanceAfter).toBe(3000);
  });

  it('refuses a debit that would drive the balance below zero (400)', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet({ balance: 500 })), update: jest.fn() },
      transaction: { create: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble));

    await expect(
      service.adjust('wallet-1', { direction: 'debit', amount: 2000, note: 'oops' }, finance),
    ).rejects.toThrow(BadRequestException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
    expect(txDouble.transaction.create).not.toHaveBeenCalled();
  });

  it('throws 404 when the wallet does not exist', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      wallet: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
      transaction: { create: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble));

    await expect(
      service.adjust('ghost', { direction: 'credit', amount: 1000, note: 'x' }, finance),
    ).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

```bash
cd backend && npm test -- wallets.service
```
Expected: FAIL — `service.adjust is not a function`.

- [ ] **Step 3: Implement.** Add this method to `WalletsService`:

```typescript
  /**
   * Finance-only direct correction/bonus. No pending stage: locks the wallet, applies a
   * credit or debit, and writes an already-settled adjustment row — all atomically.
   * Route-gated by wallet.adjust (permission), so no per-type check here.
   */
  async adjust(
    walletId: string,
    dto: { direction: 'credit' | 'debit'; amount: number; note: string },
    actor: AuthUser,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${walletId} FOR UPDATE`;
      const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
      if (!wallet) throw new NotFoundException('Wallet not found');

      const before = wallet.balance;
      const after = dto.direction === 'credit' ? before + dto.amount : before - dto.amount;
      if (after < 0) throw new BadRequestException('Adjustment would make the balance negative');

      await tx.wallet.update({ where: { id: walletId }, data: { balance: after } });
      return tx.transaction.create({
        data: {
          walletId,
          type: 'adjustment',
          amount: dto.amount,
          balanceBefore: before,
          balanceAfter: after,
          status: 'approved',
          requestedBy: actor.id,
          reviewedBy: actor.id,
          reviewedAt: new Date(),
          note: dto.note,
        },
      });
    });
  }
```

- [ ] **Step 4: Run the tests — green.**

```bash
cd backend && npm test -- wallets.service
```
Expected: 23 tests passing (19 + 4).

- [ ] **Step 5: The DTO** at `backend/src/wallets/dto/adjustment.dto.ts`:

```typescript
import { IsIn, IsInt, IsString, Min, MinLength } from 'class-validator';

export class AdjustmentDto {
  @IsIn(['credit', 'debit'])
  direction!: 'credit' | 'debit';

  @IsInt()
  @Min(1)
  amount!: number;

  // A reason is mandatory for a manual money change — this is the audit trail (M5 formalises it).
  @IsString()
  @MinLength(1)
  note!: string;
}
```

- [ ] **Step 6: The route.** In `backend/src/wallets/wallets.controller.ts`, add imports and a
      permission-gated route. This one route needs `PermissionsGuard` + `wallet.adjust` **on top of** the
      class-level `JwtAuthGuard`; a method-level `@UseGuards` runs in addition to the class guard.

Add to the imports:
```typescript
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { AdjustmentDto } from './dto/adjustment.dto';
```
Add inside `WalletsController`:
```typescript
  // Finance-only: adjust ANY wallet (no ownership check — permission-gated, not owner-gated).
  @Post(':id/adjustments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('wallet.adjust')
  adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustmentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.wallets.adjust(id, dto, actor);
  }
```

- [ ] **Step 7: Verify — compile, test, end-to-end.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; 7 suites / 52 tests (48 + 4).

With server + Postgres up (reuse `$ADMIN`, `$CUSTOMER`, `$WALLET`):
```bash
curl -s -w '\n%{http_code}\n' -X POST "http://localhost:3000/wallets/$WALLET/adjustments" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"direction":"credit","amount":5000,"note":"goodwill bonus"}'
curl -s http://localhost:3000/wallets/$WALLET -H "Authorization: Bearer $CUSTOMER" | jq '{balance}'

# A customer must NOT be able to adjust (lacks wallet.adjust) → 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3000/wallets/$WALLET/adjustments" \
  -H "Authorization: Bearer $CUSTOMER" -H 'Content-Type: application/json' \
  -d '{"direction":"credit","amount":999999,"note":"hax"}'
```
Expected: adjustment `201`, wallet balance up by `5000`; the customer attempt → `403`.

- [ ] **Step 8: Commit.**

```bash
git add backend/src/wallets
git commit -m "feat: add finance direct wallet adjustments (Milestone 4a, Task 5)"
```

---

## Task 6: Review, hardening, and learning notes

**Files:**
- Modify: `docs/learning-notes.md`
- Possibly modify: any file the review turns up

- [ ] **Step 1: Full verification.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; **7 suites, 52 tests** — 29 from M3, + 23 (`wallets.service`: 7 Task 2, 4 Task 3,
8 Task 4, 4 Task 5). If the count differs, find out why before ticking this box.

- [ ] **Step 2: Run the spec's self-review checklist** (§12 of
      `../specs/2026-07-21-wallet-milestone-4a-core-ledger-design.md`) and tick each box:
  - [ ] No `prisma.wallet` / `prisma.transaction` access outside `WalletsModule`.
  - [ ] No endpoint leaks another user's data; a customer sees only their own wallets/transactions.
  - [ ] A withdrawal cannot drive a balance below zero (proven by the concurrent-approval curl demo).
  - [ ] A request cannot be settled twice (one `200`, one `409` in the race demo).
  - [ ] Every settled row has `balanceBefore`/`balanceAfter`.

```bash
# Boundary check: the only prisma.wallet / prisma.transaction access is inside src/wallets/
grep -rn "prisma\.\(wallet\|transaction\)\." backend/src --include="*.ts" | grep -v ".spec.ts" | grep -v "src/wallets/"
```
Expected: **no output** (empty). Any line printed is a leak to fix.

- [ ] **Step 3: Read the diff with fresh eyes.** `git diff 67bae14..HEAD -- backend/`. Check: does any
      route return a raw wallet/transaction of another user? Is the lock order (txn then wallet)
      consistent in `approve`/`reject`? Does `adjust` guard against a negative result? Is `amount`
      validated positive on every money route? Fix what you find; commit separately.

- [ ] **Step 4: Append the M4a sections to `docs/learning-notes.md`.** Cover, in plain English:
  - **Money as integer minor units** — why never floats; `amount` positive + `type` for direction.
  - **The immutable ledger** — balance derived from settled rows, never edited directly;
    `balanceBefore`/`balanceAfter` as the self-verifiable chain; corrections are new `adjustment` rows.
  - **The two invariants** — settle-at-most-once (`409`) and never-negative (`400`), and which guard
    protects each.
  - **Pessimistic row locking** — the double-spend race (two approvals interleaving), how
    `SELECT ... FOR UPDATE` inside one DB transaction makes "check then subtract" indivisible, and the
    fixed lock order (txn then wallet) that pre-empts deadlocks in M4c. Include the concurrent-approval
    demo (one `200`, one `409`) as the concrete proof.
  - **Ownership-gating vs permission-gating** — two mechanisms, two questions ("is this record mine?"
    vs "does my role allow this action?"); why the customer routes use one and finance routes the
    other; why the type-specific approve permission lives in the service (data-dependent, like M3 SoD).
  - **Deliberate non-goals** — no transfers/FX/KYC yet (the M4 family order and why), no ledger
    mutation (append-only), the `403`-on-not-owned enumeration trade-off noted for later hardening.

- [ ] **Step 5: Milestone recap section** in `docs/learning-notes.md`, following the M2/M3 recap shape:
  an endpoint table (method / path / who can call it / gating), the money-movement lifecycle (request →
  pending → finance approve under locks → settled ledger row + balance change), and the deferred list
  (transfers, FX, KYC, integration-test harness, uniform-404 hardening).

- [ ] **Step 6: Commit.**

```bash
git add docs/learning-notes.md
git commit -m "docs: consolidate Milestone 4a learning notes (Milestone 4a, Task 6)"
```

- [ ] **Step 7: Update the project memory** at
      `/Users/max/.claude/projects/-Users-max-Documents-GitHub-wallet-system/memory/wallet-system-project.md`:
      mark M4a complete with its commit range and per-task ✅ list, note the M4 family
      (4a done → 4b KYC → 4c transfers → 4d FX), and set `⏭ NEXT: Milestone 4b (KYC)`. Update
      `MEMORY.md` index line accordingly.

---

## Milestone 4a self-review checklist (run before starting Milestone 4b)

- [ ] `npm test` green; `npx tsc --noEmit` clean.
- [ ] Clean commits, one per task.
- [ ] **You can explain:** why money is integer minor units; the two settlement invariants and which
      guard protects each; how pessimistic locking makes "check then subtract" indivisible and why the
      lock order is fixed; why ownership-gating is a distinct mechanism from permission-gating; and why
      the type-specific approve permission is enforced in the service rather than a route guard.

---

## What Milestone 4b will cover (preview, not yet detailed)

KYC / identity verification: a `KycSubmission` (or status on `User`) moving through
`unverified → pending → verified|rejected` via the **same request → review → approve** shape built here,
reviewed by a compliance role. Once built, the money-movement routes (`deposits`/`withdrawals`) gain a
**verified-only gate** — an authenticated user may create a wallet but cannot fund or withdraw until
verified, mirroring real e-wallet eKYC. Then M4c (transfers) and M4d (FX) build on top.
