# Wallet Management System — Design Spec

**Date:** 2026-07-13
**Status:** Approved design (pre-implementation)
**Author:** Project owner (learning-focused build)

---

## 1. Objective

Build a **portfolio-grade Wallet Management System** that demonstrates real fintech
engineering: controlled money movement, approval workflows, an auditable ledger, and
role-based access control.

The system is aimed at legitimate employers and clients — **regulated/licensed iGaming
suppliers and operators, fintech, payments, and SaaS companies**. The technology and
concepts are standard backend engineering and transfer directly across all of these
industries.

A secondary but explicit goal: **the builder must understand and be able to explain every
part of the system.** Understanding is prioritized over speed. Target completion is a
relaxed ~2–3 months (around October 2026).

This is the **centerpiece** project. Two related systems (Affiliate Dashboard, CRM / Back
Office) are **stretch goals** that reuse this system's foundation. They are explicitly
out of scope until the Wallet system is finished and polished.

---

## 2. What we are building

The Wallet Management System is two experiences sharing one backend:

**User side (a platform customer):**
- Log in, manage profile
- View wallet balance
- Request a deposit (add money)
- Request a withdrawal (take money out)
- View personal transaction history

**Admin side (platform staff):**
- Manage users
- Approve / reject deposit requests
- Approve / reject withdrawal requests
- Make manual wallet adjustments (corrections, bonuses)
- Monitor all transactions
- View audit logs

### The core flow (everything revolves around this)

```
User requests money movement
   → transaction created as PENDING (no balance change yet)
      → staff reviews
         → APPROVE: ledger records the movement + wallet balance updates (atomically)
         → REJECT:  nothing moves
   → the action is written to the audit log
```

This **request → approval → ledger entry → audit** pipeline is the fintech skill being
demonstrated. It is controlled, reviewable, traceable money movement — not "add a number
to a balance."

---

## 3. Technology stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | **Angular** + TypeScript + Angular Material + RxJS | Industry standard for enterprise/fintech/iGaming back-office UIs; sibling to NestJS (one mental model); batteries-included, good for a learner; Material gives polished admin UI fast |
| Backend | **NestJS** + TypeScript | Structured, opinionated, mirrors Angular; strong for RBAC guards and modular design |
| ORM | **TypeORM or Prisma** (decide at build start) | Maps entities to Postgres |
| Database | **PostgreSQL** | Relational integrity, transactions, foreign keys |
| Cache/Queue | **Redis** (later phases) | Sessions/queues if needed; not required for core |
| Auth | **JWT + refresh tokens + RBAC** | Standard secure auth |
| DevOps | **Docker, GitHub Actions, Nginx, VPS (AWS/DigitalOcean)** | Deployment + CI/CD for the polish phase |

Delivered as a **responsive web app**. PWA features (installable, offline) are optional
end-of-project polish — offline is not meaningful for a financial system, so this is a
cosmetic bonus only, not an architectural concern.

**Out of scope:** blockchain / crypto wallets. "Wallet" here means a fiat account-balance
ledger in a database, not an on-chain crypto wallet. Crypto deposits would be a separate
advanced module considered only after the core system is complete.

---

## 4. Data model

```
User ─────< Wallet ─────< Transaction
  │
  └──> Role ────< >──── Permission   (many-to-many via role_permissions)
  │
  └─────< AuditLog
```

### Entities

**User** — a person (customer or staff).
`id, email, password_hash, first_name, last_name, status (active/suspended), role_id, created_at, updated_at`

**Role** — a bundle of permissions.
`id, name, description`
(Seeded roles: Super Admin, Admin, Finance, Support, User)

**Permission** — one specific ability, named `resource.action`.
`id, code, description`
(e.g. `deposit.approve`, `withdrawal.approve`, `wallet.adjust`, `user.manage`, `audit.view`, `transaction.view_all`)

**Wallet** — holds a balance for a user.
`id, user_id, currency, balance, created_at, updated_at`

**Transaction** — one immutable record of money moving (the ledger).
`id, wallet_id, type, amount, balance_before, balance_after, status, requested_by, reviewed_by, reviewed_at, note, created_at`

**AuditLog** — permanent record of who did what.
`id, actor_user_id, action, entity_type, entity_id, old_value, new_value, timestamp, ip_address`

### Relationships (demonstrates the DB design checklist)

| Relationship | Type | Meaning |
|---|---|---|
| User → Wallet | one-to-many | A user can have one or more wallets; a wallet belongs to one user |
| Wallet → Transaction | one-to-many | A wallet has many transactions; each belongs to one wallet |
| User → Role | many-to-one | Many users share one role; a user has one role |
| Role ↔ Permission | many-to-many | Via `role_permissions` join table |
| User → AuditLog | one-to-many | A user (actor) generates many audit entries |

**Indexing note:** index `transactions.wallet_id` (constantly queried "all transactions
for a wallet"), and `audit_logs.actor_user_id` / `entity` for audit lookups.

---

## 5. The ledger (fintech core)

### Principle: never edit the balance directly

The balance is **derived from an immutable list of movements**, exactly like a bank
statement. Each movement is a `Transaction` row. You never mutate a settled balance in
place; you record what happened.

### Each transaction is self-verifiable

Every row stores `balance_before` and `balance_after`. This makes each row independently
checkable, and lets you verify the whole chain (each row's `balance_after` should equal
the next row's `balance_before`). A broken chain reveals corruption.

### Lifecycle

```
PENDING ──approve──> APPROVED   (compute balances, update wallet, atomically)
   │
   └──────reject────> REJECTED  (no balance change)
```

- On **request**: create transaction `status = pending`. No balance change.
- On **approve**: compute `balance_before`/`balance_after`, update wallet balance, set
  `status = approved` — all inside one database transaction.
- On **reject**: set `status = rejected`. No balance change.

### Transaction types

`deposit, withdrawal, transfer, bonus, adjustment`

### Two correctness guarantees

1. **Immutability** — settled transactions are never edited or deleted. Corrections are
   *new* compensating rows (reversal / adjustment). History is never rewritten.
2. **Atomicity (DB transactions)** — approving updates two things (the transaction row and
   the wallet balance). Both are wrapped in a database transaction so they either both
   succeed or both roll back. Row locking inside the transaction prevents race conditions
   (e.g. two admins approving the same withdrawal simultaneously, or double-spend).

### Validation rules

- A withdrawal can only be approved if `amount <= wallet.balance` at approval time.
- Amounts must be positive.
- Only pending transactions can be approved/rejected.

### Design positioning

This is a **single-entry immutable ledger with balance tracking** — a strong, complete
design for this system. Full **double-entry** accounting (balanced debits/credits across
accounts) is the bank-grade standard and a known future extension; the builder should be
able to articulate the difference in an interview.

---

## 6. Authentication & Authorization

### Auth

- Registration, login, password reset.
- On login, issue a **JWT access token** (short-lived) carrying identity + role.
- Issue a **refresh token** (long-lived) to obtain new access tokens without re-login.
- Passwords stored as hashes (bcrypt/argon2), never plaintext.

### RBAC (Role-Based Access Control)

Access is checked by **permission**, not by user identity:

```
User → has a Role → Role has many Permissions → Permission gates an action
```

**Roles → permissions (initial seed):**

| Role | Permissions |
|---|---|
| Super Admin | all |
| Admin | manage users, view all transactions, view audit logs |
| Finance | approve deposits, approve withdrawals, adjust wallets, view transactions |
| Support | view users, view transactions (read-only) |
| User | request deposit/withdrawal on own wallet, view own history |

Enforced in NestJS via **Guards** — e.g. `@RequirePermission('withdrawal.approve')` on an
endpoint returns 403 to any caller whose role lacks that permission.

### Separation of Duties (key fintech principle)

The person who **requests** money movement is never the person who **approves** it. Users
request; Finance approves. Requesting and approving are distinct permissions held by
distinct roles. This prevents single-actor fraud and is enforced through RBAC + audit.

---

## 7. Audit logging

Every critical action writes an audit entry: login activity, user modifications, deposit
approvals, withdrawal approvals, wallet adjustments.

Fields: `actor_user_id, action, entity_type, entity_id, old_value, new_value, timestamp,
ip_address`.

Audit logs are **append-only** and never edited.

---

## 8. The system spine

Every money action follows the same three-part spine:

```
RBAC check (permission) → ledger change (inside DB transaction) → audit log entry
```

Everything else (UI, profile management, plumbing) supports this spine.

---

## 9. Scope

### In scope (Wallet Management System)

- Auth (register, login, password reset, JWT + refresh)
- RBAC (roles, permissions, guards, separation of duties)
- User management (admin)
- Wallets + balances
- Deposit request + approval workflow
- Withdrawal request + approval workflow
- Wallet adjustments (admin)
- Immutable ledger with atomic settlement
- Transaction history (user) + monitoring (admin)
- Audit logging
- Dockerized deployment, CI/CD, docs, demo (polish phase)

### Explicitly out of scope (for now)

- Blockchain / crypto
- Affiliate Dashboard (stretch goal — separate spec later)
- CRM / Back Office (stretch goal — separate spec later)
- Multi-currency conversion, real payment-gateway integration (mocked/simulated instead)

---

## 10. Success criteria

The project is "done" when:

1. A user can register, log in, and request deposits/withdrawals.
2. Staff can approve/reject with RBAC enforced and separation of duties intact.
3. The ledger is immutable, atomic, and every balance is verifiable from history.
4. All critical actions are audit-logged.
5. It runs in Docker, has a CI pipeline, a clean README, architecture docs, screenshots,
   and a short demo.
6. **The builder can explain any part of it on demand** — the real success metric.
