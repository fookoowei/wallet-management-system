# Milestone 4a — Core Wallet + Ledger (design spec)

> Implements row 4 of the Milestone Roadmap in
> `2026-07-13-wallet-management-system-design.md`, and extends the RBAC built in
> `2026-07-17-wallet-milestone-3-rbac-design.md` (permission-gating) with a new **ownership-gating**
> mechanism. Date: 2026-07-21.

## 0. Milestone-family context

Milestone 4 was scoped up (with the user) from "a wallet" to a **generic multi-wallet system with
transfers and currency conversion**. Because each layer strictly depends on the one beneath it, M4 is
built as a **family of milestones**, each its own spec → plan → build:

| Phase | Deliverable | Depends on |
|---|---|---|
| **M4a (this doc)** | Core wallet + immutable ledger: create wallet, deposit/withdrawal **request → finance approve/reject**, direct adjustments, atomic settlement, ownership-gating | M2 auth, M3 RBAC |
| M4b | **KYC** — identity-verification workflow; **gates money movement** (unverified users can hold a wallet but cannot deposit/withdraw) | M4a |
| M4c | **Transfers** (same currency) — two-sided atomic debit+credit | M4a, M4b |
| M4d | **FX / currency conversion** — cross-currency transfers with rates + rounding | M4c |

The data model here is deliberately shaped for the whole family (wallets carry a `currency`; a user may
hold many) so later phases only **add**, never re-architect.

---

## 1. Goal

Turn the seeded-but-unused money permissions (`deposit.approve`, `withdrawal.approve`, `wallet.adjust`,
`transaction.view_all`) into a working, auditable ledger. A customer **requests** money movement; a
`finance` user **approves**; approval settles the balance **atomically and exactly once**, recording a
self-verifiable ledger row. This is the fintech core: *money changes only via a settled, immutable
transaction, never by editing a balance directly.*

---

## 2. Scope

**In scope:**
- `Wallet` and `Transaction` (ledger) models + one migration.
- A `WalletsModule` owning all `prisma.wallet` / `prisma.transaction` access (mirrors how `UsersModule`
  is the sole owner of user/role data — one owner per table).
- Customer routes (ownership-gated): create wallet, list my wallets, get one wallet, request deposit,
  request withdrawal, list a wallet's transactions.
- Finance routes (permission-gated): list pending, approve, reject, direct adjustment.
- Atomic settlement with **pessimistic row locking** (§4) protecting two invariants (§6).
- Money as **integer minor units**; amounts validated positive; balance never negative.
- New **ownership-gating** authorization mechanism (§5).

**Out of scope (deferred, with reason):**
- **Transfers between wallets** → M4c. A transfer is two ledger writes; needs its own spec.
- **Currency conversion / FX** → M4d.
- **KYC / verification gating** → M4b. M4a lets any authenticated user deposit/withdraw; the gate wraps
  the money-movement step later.
- **Wallet close / freeze / status** — YAGNI for M4a; add if a later phase needs it.
- **Pagination on transaction history** — a simple capped list for now (reuse the M3 query-DTO pattern
  if a list grows; not a focus here).
- **Editing or deleting transactions** — the ledger is append-only by definition. Corrections happen via
  a new `adjustment` row, never by mutating history.

---

## 3. Concurrency decision (the milestone's core)

**The problem:** "read balance → check it's enough → subtract" is three steps. If two approvals
interleave, both can read a stale balance and both subtract, driving the wallet negative (money created
from nothing). Separately, two approvals of the *same* request can each settle it (money paid twice).

**Options considered:**

| Option | Mechanism | Verdict |
|---|---|---|
| **A — Pessimistic row lock** ✅ | `SELECT ... FOR UPDATE` the row inside a transaction; a second writer waits until the first commits, then sees fresh state | **Chosen.** Clearest mental model ("hold the row while settling"); generalises to transfers (lock both wallets, consistent order); the textbook fintech answer. |
| B — Conditional atomic update | `UPDATE ... WHERE balance >= amount`; `count === 0` ⇒ insufficient | Correct and Prisma-idiomatic; the check hides in SQL and the pattern is less illustrative of *why* the race exists. Considered, not chosen. |
| C — Serializable + retry | `SERIALIZABLE` isolation; catch serialization failure; retry | Correct but adds a retry loop and a rare path to test; least intuitive to learn on. |

Both A and B are legitimate production choices (both bottom out in the DB's row locking — A holds an
explicit lock across the transaction; B relies on the momentary lock of a single statement). A was
chosen for **understandability and future-proofing toward transfers**, in line with the project's
"understand every line" goal.

**Implementation shape (Prisma):** an interactive transaction — `prisma.$transaction(async (tx) => …)` —
with `SELECT ... FOR UPDATE` issued via `tx.$queryRaw` to acquire row locks (Prisma has no native
`FOR UPDATE` on `findUnique`). Locks are held until the transaction commits/rolls back. **Lock ordering
is fixed** (transaction row, then wallet row) to avoid deadlocks; this ordering rule becomes important
in M4c when two wallets are locked.

---

## 4. Data model

Two new tables. Money is **integer minor units** (cents) everywhere — no floats, no rounding drift.

### `Wallet`
| field | type | notes |
|---|---|---|
| `id` | uuid (pk) | |
| `userId` | uuid → User | owner; a user may have many wallets |
| `name` | string | e.g. `main`, `savings` |
| `currency` | string | ISO code, e.g. `USD`; fixed per wallet (FX is M4d) |
| `balance` | int | minor units; **invariant: never < 0** |
| `createdAt` / `updatedAt` | timestamps | |

Index `userId` (constant "my wallets" lookups). A user's `(userId, name)` need not be unique in M4a
(keep it simple); revisit if a UI needs it.

### `Transaction` (the immutable ledger)
| field | type | notes |
|---|---|---|
| `id` | uuid (pk) | |
| `walletId` | uuid → Wallet | which wallet |
| `type` | string | `deposit` \| `withdrawal` \| `adjustment` |
| `amount` | int | minor units, **always positive**; `type` carries direction |
| `balanceBefore` | int? | null while pending; set at settlement |
| `balanceAfter` | int? | null while pending; set at settlement |
| `status` | string | `pending` \| `approved` \| `rejected` |
| `requestedBy` | uuid → User | who initiated |
| `reviewedBy` | uuid → User? | finance user who approved/rejected (null while pending) |
| `reviewedAt` | timestamp? | null while pending |
| `note` | string? | optional reason (adjustments, rejections) |
| `createdAt` | timestamp | |

Index `walletId` (constant "this wallet's history" lookups) and `status` (the pending queue).

**Two modelling decisions:**
- **`amount` is always positive; `type` says direction.** Reads like a bank statement, avoids sign bugs.
  An `adjustment` still stores a positive `amount`; its *effect* (credit vs debit) is carried by a
  direction the DTO supplies (see §7).
- **`balanceBefore/After` are only populated on settlement.** A `pending` row hasn't moved money, so
  those are null until an approval (or an adjustment, which settles immediately). The chain
  (`row.balanceAfter == next settled row.balanceBefore` for a wallet) is thus defined over settled rows.

---

## 5. Authorization model

Guard order is unchanged from M3: `@UseGuards(JwtAuthGuard, PermissionsGuard)` — authenticate, then
authorize. M4a adds a **third, orthogonal** check.

### Permission-gating (M3, reused) — finance routes
Approve/reject/adjust/list-pending sit behind `PermissionsGuard` with the relevant permission. Because
which approve permission is required depends on the transaction's **`type`** (data known only after
loading the row), the *type-specific* check lives in the **service**, not a static route guard — exactly
like M3's separation-of-duties rules. Approving a `deposit` requires `deposit.approve`; a `withdrawal`
requires `withdrawal.approve`; missing it ⇒ **403**.

### Ownership-gating (NEW) — customer routes
A customer holds no special permission; they may act **only on wallets they own**. Since ownership is a
property of the loaded row (`wallet.userId === actor.id`), this is a **service-layer check**, not a
static guard. Acting on someone else's wallet ⇒ **403** (deliberately not 404 — but see the note below).

> **Enumeration note:** returning 403 vs 404 for "not yours" vs "doesn't exist" can leak whether a
> wallet id exists. For M4a we accept 403-on-not-owned for clarity; a hardening note (return a uniform
> 404 for both) is recorded for a later pass. Wallet ids are uuids, so enumeration risk is low.

Ownership-gating and permission-gating are **different mechanisms** for **different questions**:
permission = "does your *role* allow this *kind* of action?"; ownership = "is this specific *record*
yours?". Customer routes need ownership; finance routes need permission; neither substitutes for the
other. (Suspended-account denial from M3's `PermissionsGuard` still applies wherever that guard runs.)

---

## 6. The two invariants and atomic settlement

Settlement must protect **two independent invariants**, each needing its own guard:

1. **A request settles at most once** — no double-approval. Guard: the status transition
   `pending → approved|rejected` happens under a row lock; a second approver, once it acquires the lock,
   sees a non-`pending` status and is refused **409**.
2. **A balance never goes negative** — no overdraft. Guard: the wallet row is locked before its balance
   is read and written, so concurrent settlements serialise and each sees the true current balance;
   a withdrawal whose amount exceeds the locked balance is refused **400**.

### Approve (withdrawal) — the full path
All inside one `prisma.$transaction`:
```
1. Lock the transaction row (SELECT ... FOR UPDATE).
   - not found            → 404
   - status !== 'pending' → 409  (already reviewed / double-approval loser)
2. Lock the wallet row (SELECT ... FOR UPDATE).   [fixed order: txn then wallet]
3. before = wallet.balance
   withdrawal: if before < amount → 400 insufficient (transaction rolls back)
               after = before - amount
   deposit:    after = before + amount
4. UPDATE wallet.balance = after
5. UPDATE transaction SET status='approved', reviewedBy=actor, reviewedAt=now,
          balanceBefore=before, balanceAfter=after
commit → settled exactly once, balance correct, locks released
```
Because every step is in one DB transaction, an insufficient-funds throw at step 3 **rolls back** the
status claim from step 1 — the request returns to `pending` and can be retried later.

### Other flows (same skeleton)
- **Approve deposit** → step 3 adds; no sufficiency check.
- **Reject** → lock txn; if not `pending` → 409; set `status='rejected'`, `reviewedBy/At`; **no wallet
  lock, no balance change**.
- **Adjustment** (finance direct, `wallet.adjust`) → no pending stage: one `$transaction` that locks the
  wallet, applies a credit or debit (a debit may not drive balance < 0 → 400), and writes a **settled**
  `adjustment` row (`status='approved'`, `reviewedBy=actor`, before/after recorded). Requires a `note`.
- **Request deposit / withdrawal** (customer) → create a `pending` row, `requestedBy=actor`, no lock, no
  balance change. A withdrawal request MAY do a *non-authoritative* balance pre-check for a friendly
  early 400; the authoritative check is always at approval.

---

## 7. Endpoints

**Customer (ownership-gated):**
| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/wallets` | `{ name, currency }` | 201 wallet |
| `GET` | `/wallets` | — | my wallets |
| `GET` | `/wallets/:id` | — | one wallet (must own) |
| `POST` | `/wallets/:id/deposits` | `{ amount, note? }` | 201 pending txn |
| `POST` | `/wallets/:id/withdrawals` | `{ amount, note? }` | 201 pending txn |
| `GET` | `/wallets/:id/transactions` | — | that wallet's ledger (must own) |

**Finance (permission-gated):**
| Method | Path | Body | Permission | Result |
|---|---|---|---|---|
| `GET` | `/transactions/pending` | — | `transaction.view_all` | pending queue |
| `POST` | `/transactions/:id/approve` | — | `deposit.approve` / `withdrawal.approve` (by type, in service) | 200 settled txn |
| `POST` | `/transactions/:id/reject` | `{ note? }` | same as approve, by type | 200 rejected txn |
| `POST` | `/wallets/:id/adjustments` | `{ direction: 'credit'\|'debit', amount, note }` | `wallet.adjust` | 201 settled txn |

Amounts are validated (`@IsInt`, `@Min(1)`) — positive minor units only. Responses never include
another user's data; a customer's transaction list is their own wallet's rows only.

---

## 8. Error semantics

| Code | Meaning | Raised by |
|---|---|---|
| 401 | no/invalid access token | `JwtAuthGuard` (M2) |
| 403 | not your wallet (ownership); wrong approve-permission for the type; suspended account | service / `PermissionsGuard` (M3) |
| 404 | wallet or transaction not found | service |
| 400 | amount not a positive integer; withdrawal/debit-adjustment exceeds balance | DTO validation / settlement |
| 409 | approve/reject a transaction whose status is not `pending` (double-approval guard + already-handled) | settlement |

---

## 9. Testing strategy

**Layer 1 — unit tests (mocked Prisma), TDD backbone**, one behaviour each:
- deposit request → `pending` row, no balance change
- approve deposit → balance up, before/after recorded, `approved`
- approve withdrawal (funds ok) → balance down, recorded, `approved`
- approve withdrawal (insufficient) → **400**, nothing settled
- approve/reject non-`pending` → **409** (the double-approval branch, simulated by the mock)
- reject → `rejected`, no balance change
- adjustment credit/debit → settles immediately, before/after correct; debit below zero → **400**
- ownership violation → **403**; wrong approve-permission for type → **403**
- amount validation (DTO) → non-positive / non-integer → **400**

**Layer 2 — one integration test (real Postgres).** Mocks can't lock, so they can't prove the race.
Fire **two concurrent approvals of the same pending request** (`Promise.all`) against real Postgres and
assert **exactly one wins** (one 200, one 409) and the wallet is debited **once**. This is the test that
proves the design, not merely the branch handling. (A second concurrency test: two different
withdrawals against a wallet with funds for only one → one 200, one 400.)

**Layer 3 — end-to-end curl demo:** create wallet → request deposit → finance approve → balance moves;
request withdrawal beyond balance → 400; direct adjustment → balance moves; double-approve a request →
one 200 + one 409.

---

## 10. Deliberate non-goals recap (and why)

- **No transfers / FX** — dependency-ordered into M4c/M4d; building them here would balloon the money
  surface before the core ledger is proven.
- **No KYC gate** — M4b; and building the ledger's approve workflow first means KYC (the same
  request→review→approve shape) reuses a pattern already understood.
- **No wallet freeze/close, no history pagination, no ledger mutation** — YAGNI / append-only by design.
- **403-on-not-owned enumeration** — accepted for clarity; uniform-404 hardening noted for later.

---

## 11. Task breakdown (rough — the plan will detail with TDD steps)

1. **Schema + migration + `WalletsModule` skeleton.** `Wallet`/`Transaction` models, migration, module
   owning `prisma.wallet`/`prisma.transaction`; register in `AppModule`. Boot check.
2. **Wallet CRUD-lite + ownership-gating.** `POST /wallets`, `GET /wallets`, `GET /wallets/:id`,
   `GET /wallets/:id/transactions`; ownership check in the service; TDD.
3. **Requests.** `POST /wallets/:id/deposits` and `/withdrawals` → pending rows; DTO validation; TDD.
4. **Settlement.** `approve` / `reject` with pessimistic-lock atomic flow + type-specific permission;
   TDD (incl. the 400/409 branches) + the real-Postgres race test.
5. **Adjustments.** `POST /wallets/:id/adjustments`, immediate settled row; TDD.
6. **Review + learning notes + memory.** Self-review checklist, `learning-notes.md` M4a sections
   (ledger, minor units, the two invariants, pessimistic locking, ownership vs permission gating),
   update project memory; mark M4a done, set M4b next.

---

## 12. Self-review checklist (run before starting M4b)

- [ ] `npm test` green; `npx tsc --noEmit` clean.
- [ ] No `prisma.wallet` / `prisma.transaction` access outside `WalletsModule`.
- [ ] No endpoint returns a raw row that leaks another user's data; a customer sees only their own.
- [ ] A withdrawal cannot drive a balance below zero, proven by the real-Postgres concurrency test.
- [ ] A request cannot be settled twice, proven by the concurrent-approval test (one 200, one 409).
- [ ] Every settled row has `balanceBefore`/`balanceAfter`; the chain verifies for a wallet.
- [ ] **You can explain:** why money is integer minor units; the two invariants and which guard protects
      each; how pessimistic locking makes "check then subtract" indivisible; and why ownership-gating is
      a separate mechanism from permission-gating.
