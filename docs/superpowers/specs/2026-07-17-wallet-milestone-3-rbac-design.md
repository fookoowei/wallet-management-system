# Milestone 3 — RBAC (design)

**Date:** 2026-07-17
**Status:** approved, ready for planning
**Depends on:** Milestone 2 (authentication) — complete

---

## 1. Goal

Make the `Role ↔ Permission` model seeded in Milestone 1 actually *do* something. Routes
become gated by permission, roles are enforced, and a user's access can be revoked
immediately.

**Deliverable:** an admin surface (`/users`, `/roles`) where every route is gated by a
permission the caller's role must hold, enforced by a `PermissionsGuard` written and
tested by us.

**No schema changes.** The `Role`, `Permission`, and the `PermissionToRole` many-to-many
have existed since M1 and are seeded (6 permissions, 5 roles). This milestone is pure
application logic: no migration, no `prisma:generate`.

---

## 2. Key decision: where the guard reads permissions from

The access JWT carries identity only (`{sub, email, role}`). Something has to answer
"does this caller hold `user.manage`?". Three options were considered:

| | Suspension takes effect | DB per request | Complexity |
|---|---|---|---|
| **A** — permissions baked into the JWT at login | up to 15 min later | zero | low |
| **B** — DB lookup inside the guard, per request | immediately | one indexed join | low |
| **C** — B plus a short-TTL in-memory cache | up to TTL later | ~zero after first | high (invalidation) |

**Chosen: B — DB lookup per request.**

A and C are not faster versions of B; they trade **correctness for speed**. A signed JWT
cannot be edited or un-issued, so under A a suspended user keeps full authority until
their token expires — which would make this milestone's own `PATCH /users/:id/status`
endpoint misleading for up to 15 minutes. In a system whose premise is moving money,
"revoke access" must mean *now*.

The cost of B is one indexed `user → role → permissions` join per guarded request —
negligible next to the bcrypt already run on every login, and invisible at this scale
(one API instance, a few hundred staff users).

C additionally requires cache invalidation on every role/status change, and breaks
silently across multiple API instances (each holds its own cache). It solves a
performance problem that does not exist here.

**Documented, deliberately not built:** the C cache. It is the correct answer *if* the
guard's query ever becomes a bottleneck, and the trade-off (a staleness window equal to
the TTL, plus invalidation bugs) should be made knowingly.

---

## 3. Scope

### In scope

- `UsersService` / `UsersModule` — extracted from `AuthService` (deferred from M2).
- `@RequirePermissions(...codes)` decorator.
- `PermissionsGuard`.
- `UsersController`: `GET /users`, `GET /users/:id`, `PATCH /users/:id/status`,
  `PATCH /users/:id/role`.
- `RolesController`: read-only `GET /roles`.

### Out of scope (deliberate)

**Roles/permissions CRUD.** Roles are seed data, not runtime data — they are part of the
system's design. Beyond that, a screen that edits permission sets is a *privilege
escalation vector*: anyone who can edit a role can grant themselves `withdrawal.approve`,
which makes every control in this milestone bypassable through one endpoint. Locking
roles to seed data is the safer design. Nothing downstream needs it — the M6 frontend
scope (approvals, users, monitoring, audit) does not include role administration. If it
is ever wanted, it is a small self-contained addition; nothing in M3 blocks it.

**Ownership checks.** Permission-gating ("does your role allow this action?") and
ownership-gating ("is this row yours?") are different mechanisms. The seeded `user` role
holds zero permissions by design, so every M3 route is admin-only and customers are
correctly locked out of all of them. M4's customer wallet routes will be ownership-gated
instead, and are left to M4 so the two ideas stay distinct.

**Revoking refresh tokens on suspension.** Suspending a user does not delete their
`RefreshToken` rows, so they can keep minting fresh access tokens. This is deliberately
tolerated for now: `PermissionsGuard` reads `status` from the DB on every gated request,
so a suspended user is refused on every route in this milestone regardless of how new
their token is. The tokens are keys to a door that no longer opens.

It becomes a real gap in M4, when customer wallet routes are ownership-gated rather than
permission-gated. The rule that resolves it: **status is checked by whichever guard
already does a DB read** — `PermissionsGuard` here, the ownership guard in M4.

It is not fixed now because the clean fix forces a **circular module dependency**:
`TokensService` owns the `RefreshToken` table and lives in `AuthModule`, which already
imports `UsersModule`. Having `UsersModule` import `AuthModule` back would require
`forwardRef`. Paying that structural cost for a hole that nothing can currently exploit is
the wrong trade. Revisit in M4, where the extra route surface justifies picking a
resolution (move `TokensService` to its own module, or emit a domain event).

**Caching** — see §2.

---

## 4. Components

### 4.1 `UsersService` (`src/users/users.service.ts`)

Becomes the **only** code that touches `prisma.user`. `AuthService` stops querying users
directly and keeps only what it is about: password hashing, credential verification, and
token orchestration.

| Method | Used by |
|---|---|
| `create(data)` | `AuthService.register` |
| `findByEmailWithRole(email)` | `AuthService.login` |
| `findByIdWithPermissions(id)` | `PermissionsGuard` |
| `findMany({ skip, take })` | `GET /users` |
| `findById(id)` | `GET /users/:id` |
| `updateStatus(id, status, actor)` | `PATCH /users/:id/status` |
| `updateRole(id, roleName, actor)` | `PATCH /users/:id/role` |

`actor` is the authenticated caller (`AuthUser`, supplied by `@CurrentUser`). Both write
methods need it: the §5 rules compare the actor's id against the target's, and
`updateRole` additionally needs the actor's role.

**`toSafeUser` is a pure function** (`src/users/to-safe-user.ts`), *not* a service method.
It strips `passwordHash` and has no dependencies, so DI would be ceremony — and, more
importantly, a method on a mocked `UsersService` would make the existing
"register returns no password hash" assertion vacuous. As a plain import it stays real in
every test. It currently exists as inline destructuring in `AuthService.register` and is
centralised here. **No user-shaped response may ever include `passwordHash`.**

`findByIdWithPermissions` is the one exception: it returns the raw row (hash included)
because only `PermissionsGuard` consumes it, and its result never reaches a response.

`TokensService` keeps its own `PrismaService` dependency — it owns the `RefreshToken`
table, which is not a user table. Only *user-row* access moves.

### 4.1a `RolesService` (`src/users/roles.service.ts`)

`Role` is its own entity, so role queries do not belong in `UsersService`. A small
read-only service owns them:

| Method | Used by |
|---|---|
| `findByName(name)` | `AuthService.register` (resolve the default `user` role), `UsersService.updateRole` |
| `findAll()` | `GET /roles` |

No write methods — roles are seed data (§3).

### 4.2 `@RequirePermissions(...codes)` (`src/auth/require-permissions.decorator.ts`)

A `SetMetadata` decorator. It performs no logic — it pins required permission codes to
the route handler as metadata for a guard to read later.

Counterpart to `@CurrentUser` from M2: same mechanism family, opposite direction.
`@CurrentUser` *reads* from the request at call time; `@RequirePermissions` *writes* onto
the route at definition time.

Multiple codes mean **all are required** (AND). No route in this system currently needs
more than one; the list exists so the guard's contract is unambiguous rather than to
serve a present need.

### 4.3 `PermissionsGuard` (`src/auth/permissions.guard.ts`)

1. Read required codes via `Reflector` (handler, then class).
2. **No codes → allow.** A route that never asked for a permission is not this guard's
   business.
3. Read `request.user.id` — placed there by `JwtAuthGuard`.
4. `usersService.findByIdWithPermissions(id)`.
5. User missing → **403**.
6. `user.status !== 'active'` → **403 `Account suspended`**.
7. Role's permission codes must cover every required code → else **403**.

Used as `@UseGuards(JwtAuthGuard, PermissionsGuard)`. **Order matters:** Nest runs guards
left to right, and `PermissionsGuard` is meaningless until `JwtAuthGuard` has established
who is calling. Authentication then authorization; identity then privilege.

No `super_admin` bypass. The seed grants `super_admin` every permission explicitly, so a
bypass branch would be redundant logic on the security-critical path.

### 4.4 Routes

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/users` | `user.manage` | paginated via `?skip&take`, sane defaults |
| `GET` | `/users/:id` | `user.manage` | 404 if absent |
| `PATCH` | `/users/:id/status` | `user.manage` | body `{ status: 'active' \| 'suspended' }` |
| `PATCH` | `/users/:id/role` | `user.manage` | body `{ role: <role name> }` |
| `GET` | `/roles` | `user.manage` | read-only; feeds the M6 role dropdown |

---

## 5. Separation of duties

Two rules on the write endpoints. These are the substance of the milestone.

**You cannot change your own role.** `user.manage` is held by `admin`. Without this rule
an admin could promote themselves to `super_admin` and inherit every permission in the
system — including `withdrawal.approve`, deliberately withheld from them. One `PATCH`
would dissolve the entire model.

**You cannot suspend yourself.** Prevents self-lockout.

**Only a `super_admin` may assign the `super_admin` role.** Blocking self-promotion is
pointless if an admin can crown an accomplice instead.

**Accepted and not prevented:** an `admin` may set another user to `finance`, granting
`withdrawal.approve` — a permission the admin does not hold. This is delegation, not
escalation, and it mirrors how real organisations work (HR onboards the finance team
without being able to move money). The control here is not prevention but the audit
trail, which M5 provides.

---

## 6. Error semantics

- **401 Unauthorized** — *identity unknown*: missing, malformed, or expired token.
  `JwtAuthGuard`'s responsibility.
- **403 Forbidden** — *identity known, action refused*: valid token, real user,
  insufficient permission. `PermissionsGuard`'s responsibility.

A suspended user holding a still-valid access token receives **403 `Account suspended`**:
they authenticated successfully and are simply no longer permitted to act. Retrying will
not help, which is what 403 communicates and 401 does not.

`403` bodies stay vague about *which* permission was missing — the caller learns they may
not act, not the shape of the permission model.

---

## 7. Testing

M2 established that `JwtAuthGuard` and `JwtStrategy` are **plumbing** — thin wrappers over
Passport containing no logic of ours — and were verified by `curl` rather than unit tests.

`PermissionsGuard` is the opposite: our code, branching logic, and the only thing standing
between a support agent and withdrawal approvals. It gets full TDD.

**`PermissionsGuard`:** no metadata → allow · has required permission → allow · missing one
of several required → deny · suspended user → deny · user absent from DB → deny.

**`UsersService`:** `findByIdWithPermissions` includes role and permissions · `toSafeUser`
strips `passwordHash` · `findMany` applies pagination · `updateStatus` / `updateRole`
enforce the §5 rules.

**Regression through the Task 1 extraction.** A precise rule, because "don't touch the
tests" would be wrong here:

- **Every assertion must stay identical.** Assertions describe *behaviour*, and a refactor
  changes none.
- **The mock wiring in `auth.service.spec.ts` must change** — from a `PrismaService` mock
  to a `UsersService` mock — because `AuthService`'s collaborator changed. That is expected.

This is itself the lesson: mock-based unit tests are coupled to *who a class talks to*, so
changing collaborators forces test edits even when behaviour is untouched. That is the
price of isolation, and it is worth feeling once deliberately. Editing a **wiring line** is
routine; editing an **assertion** means behaviour drifted — stop and investigate.

`tokens.service.spec.ts` is untouched (`TokensService` keeps `PrismaService`, §4.1).

---

## 8. Task breakdown

| # | Task | Testing |
|---|---|---|
| 1 | Extract `UsersService` + `RolesService` + `UsersModule`; rewire `AuthService` | Refactor — assertions unchanged, mock wiring rewired (§7) |
| 2 | `@RequirePermissions` + `PermissionsGuard` | Full TDD |
| 3 | Read routes: `GET /users`, `GET /users/:id`, `GET /roles` | TDD on service |
| 4 | `PATCH /users/:id/status`, `PATCH /users/:id/role` + §5 rules | Full TDD |
| 5 | Review, hardening, learning-notes consolidation | — |

**Task 1 is a pure refactor: zero behaviour change.** The existing tests are the safety
net, under the rule in §7 — rewiring a mock is expected, changing an assertion is a
red flag.

Commit convention: one conventional commit per task; the user pushes.

---

## 9. Milestone self-review checklist

- [ ] `npm test` green; `npx tsc --noEmit` clean.
- [ ] A `user`-role account receives 403 on every `/users` route.
- [ ] A suspended user's still-valid access token receives 403 immediately — not after
      15 minutes.
- [ ] An `admin` cannot promote themselves or anyone else to `super_admin`.
- [ ] No response anywhere includes `passwordHash`.
- [ ] **You can explain:** why the guard queries the DB instead of trusting the token; the
      difference between 401 and 403; why `PermissionsGuard` is unit-tested when
      `JwtAuthGuard` was not; and why permission-gating and ownership-gating are separate
      mechanisms.
