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
| `toSafeUser(user)` | everywhere a user is returned |

`actor` is the authenticated caller (`AuthUser`, supplied by `@CurrentUser`). Both write
methods need it: the §5 rules compare the actor's id against the target's, and
`updateRole` additionally needs the actor's role.

`toSafeUser` strips `passwordHash`; it currently exists as inline destructuring in
`AuthService.register` and is centralised here. **No user-shaped response may ever
include `passwordHash`.**

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

**Regression:** the 13 existing M2 tests must remain green through the Task 1 extraction
without modification (see §8).

---

## 8. Task breakdown

| # | Task | Testing |
|---|---|---|
| 1 | Extract `UsersService` + `UsersModule`; rewire `AuthService` | Refactor — existing 13 tests stay green |
| 2 | `@RequirePermissions` + `PermissionsGuard` | Full TDD |
| 3 | Read routes: `GET /users`, `GET /users/:id`, `GET /roles` | TDD on service |
| 4 | `PATCH /users/:id/status`, `PATCH /users/:id/role` + §5 rules | Full TDD |
| 5 | Review, hardening, learning-notes consolidation | — |

**Task 1 is a pure refactor: zero behaviour change.** The existing tests are the safety
net. If a test needs editing to pass, that is the signal that behaviour changed by
accident — investigate rather than edit the test.

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
