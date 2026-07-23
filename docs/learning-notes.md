# Wallet System — Learning Notes

Plain-English notes on the concepts behind what we build. A running reference —
we add to it as we go. (For the build steps themselves, see the plan + spec docs.)

---

## Docker: image vs container vs volume

- **Image** = a frozen template (e.g. "PostgreSQL 16, installed"). Downloaded once, cached forever. Like a *recipe*.
- **Container** = a live, running copy made from an image. Like the *cooked dish*.
- **Volume** = a storage box that lives *outside* the container, so data survives even if the container is deleted. Like a *save file*.
- **Why:** run an identical database on any machine with one command, delete it cleanly, no messy install.

Careful command: `docker compose down -v` — the `-v` deletes the volume (wipes data). Everything else keeps data.

---

## Secrets & `.env`

- Real secrets (DB password, keys) go in `.env`, which is **gitignored** — never committed.
- `.env.example` (committed) is a template with fake values, so others know what to set.
- **Rule:** structure/config goes in git; secret *values* stay out of git.

---

## ORM (we use Prisma)

- A translator between your **TypeScript code** and the database's **SQL**.
- You write `prisma.user.findUnique(...)`; Prisma writes the SQL for you.
- **Why:** type-safe (mistakes caught before running), autocomplete, and safe from SQL-injection attacks.

---

## Schema as source of truth

- One file — `schema.prisma` — describes all your tables. It's the authority.
- From it, Prisma derives **two** things: the database tables *and* the typed TypeScript client.
- **Why:** change one file → DB and code types stay in sync. No drift.

---

## Migrations

- A **versioned history** of your database's structure — like git commits, but for table shapes.
- `prisma migrate dev` compares schema → DB, writes the SQL, applies it, and records it.
- **Why:** history of every change, and anyone can recreate an identical database by replaying them.
- Mental model: **schema = the destination; migrations = the directions to get there.**

---

## RBAC (Role-Based Access Control)

- Don't give permissions to users directly. Give **permissions → roles**, and **roles → users**.
- `User` has one `Role`; a `Role` bundles many `Permission`s; a user inherits its role's permissions.
- **Why:** manage access for 500 users by editing a *role* once, not 500 users. Auditable, and enforces
  *separation of duties* (whoever requests money movement ≠ whoever approves it).

---

## Many-to-many & the join table

- A `Role` has many `Permission`s AND a `Permission` belongs to many `Role`s. One foreign-key column can't hold "many."
- Solution: a **join table** (`_PermissionToRole`) where each **row** is one pairing (this permission ↔ this role).
- Prisma created it automatically from `permissions Permission[]` / `roles Role[]` in the schema.

---

## NestJS Dependency Injection (DI)

- You don't build shared services with `new`. You **declare** you need one in the constructor, and NestJS **hands** you the single shared instance.
- Three pieces: `@Injectable()` (available), `providers` (owned by a module), `exports`/`@Global()` (shareable).
- To use a service: `constructor(private prisma: PrismaService) {}`.
  - **Global module** (like our `PrismaModule`): registered once in `AppModule`, then usable anywhere — no re-import.
  - **Normal module:** must also add it to the consuming module's `imports`.
- **Why:** one shared instance (one DB connection pool), easy to swap a fake in tests, loose coupling.

---

## Password hashing with bcrypt

- **Never store real passwords.** Store a **hash** — a one-way scrambled version.
- One-way: password → hash is easy; hash → password is impossible.
- To check a login: hash what the user typed, compare to the stored hash. Never "unlock" the stored one.
- **bcrypt** adds two things:
  - **Salt** — random data mixed in, so identical passwords get different hashes (beats precomputed-hash attacks).
  - **Deliberately slow** — the cost factor (`10`) makes each hash take a moment, so a stolen DB is far slower to brute-force.

---

## Prisma Studio (visual data browser)

- Run `npm run prisma:studio` from `backend/`, then open **http://localhost:5555** in a browser.
- Shows every table as a spreadsheet-like grid; click a table to see its rows, click a row to see linked data. Read + write.
- Stop it with `Ctrl+C` in the terminal that's running it.
- (Docker Desktop's GUI is *not* a data browser — use Studio, or a DB client like TablePlus/DBeaver connecting via `DATABASE_URL`.)

---

## Redis — not used (optional future)

- We are **not** using Redis. Core wallet features (ledger, RBAC, auth, audit) work with **PostgreSQL only**; financial correctness lives in the DB, not a cache.
- Redis is a fast in-memory store used for caching, session/token denylists, rate limiting, or background job queues.
- **Possible future/stretch use:** rate-limiting login attempts, or a job queue for async transaction processing. A good "how would you scale this?" talking point — added later, never a prerequisite.

---

## TDD (Test-Driven Development) & mocking

- The loop: **Red → Green → Refactor.**
  1. **Red** — write the test *first*, run it, watch it fail (proves the test actually checks something).
  2. **Green** — write the minimum code to make it pass.
  3. **Refactor** — clean up, keep the test passing.
- **Mocking** — in a unit test, replace a real dependency with a fake. For `HealthService` we injected a fake `PrismaService` whose `$queryRaw` just *pretends* to succeed or fail — so the test needs no real database. Fast, isolated, deterministic.
- **This only works because of DI:** the service *receives* `PrismaService` in its constructor, so a test can hand it a fake instead of the real one.
- **Controller vs Service:** the *service* holds logic (and is unit-tested); the *controller* just maps an HTTP route (`GET /health`) to a service call.

---

## DTOs & request validation

- A **DTO** (Data Transfer Object) is a small class describing the *shape* of an incoming request body — e.g. `RegisterDto` has `email`, `password`, `firstName`, `lastName`.
- **Decorators** like `@IsEmail()` / `@MinLength(8)` (from `class-validator`) declare the rules right on the fields.
- The global **`ValidationPipe`** (turned on once in `main.ts`) reads those rules on every request and auto-rejects bad bodies with a `400` — so controllers never see garbage input.
  - `whitelist: true` → strips any field the DTO didn't declare (stops a caller sneaking in `role: "super_admin"`).
  - `transform: true` → turns the raw JSON into a real DTO instance, which is what makes the decorators actually run.
- **Why:** validation lives in one declarative place, not scattered `if` checks; the door is guarded before any business logic runs.

---

## Returning data safely (don't leak secrets)

- Never return the `passwordHash` (or other secrets) to the client. In `register()` we strip it with destructuring:
  `const { passwordHash: _passwordHash, ...safeUser } = user;` → `safeUser` has everything *except* the hash.
- **HTTP status via exceptions:** throwing `ConflictException` → `409`, `UnauthorizedException` → `401`, etc. NestJS maps the exception type to the right status code automatically.

---

## Login & the two-token model

- **Two tokens, two jobs:** logging in mints an **access token** (a short-lived, signed JWT — proves who you are on every request, 15 min) and a **refresh token** (a long-lived opaque string used only to get a *new* access token).
- **`TokensService.issueTokens(user)`** is the factory: it signs the JWT with the claims `{ sub, email, role }` and stores a **new refresh-token row** in the DB (only the SHA-256 *hash* of the token, never the raw value).
- **`AuthService.login(dto)`**: look up the user by email, `bcrypt.compare` the password to the stored hash, and only then issue tokens.
- **Anti-enumeration:** "no such email" and "wrong password" throw the *same* vague `401 Invalid credentials`. If they differed, an attacker could probe `/login` to discover which emails have accounts.
- **Structural typing:** `issueTokens` declares it needs only `{ id, email, role: { name } }`. We pass the full fat Prisma `user` — extra fields are allowed as long as the required ones are present. The narrow parameter type documents the function's real needs and keeps it easy to test.

## Token *minting* vs *rotation* (what's built vs coming)

- Built so far: **minting** only — login *adds* a fresh token pair. Nothing gets deleted yet.
- Still to come (next task): **rotation** — when the access token expires, the client sends its refresh token back; the server verifies it, **deletes that row (single-use)**, and issues a new pair. Plus **revoke** (logout = delete the row). Both reuse `issueTokens`, which is why minting had to exist first.

---

## Protecting routes (guard + strategy + decorator)

Goal: mark a route as "valid access token required" and hand the logged-in user's identity to the handler. Four small pieces, and a request flows through them in order:

1. **`JwtStrategy`** (`jwt.strategy.ts`) — the *verifier*. It pulls the token from the `Authorization: Bearer <token>` header, checks the **signature** (same `JWT_ACCESS_SECRET` we signed with) and the **expiry** (`ignoreExpiration: false` is what enforces the 15-min lifetime). Its `validate()` runs only *after* those pass, and reshapes the raw payload (`sub,email,role`) into a clean `AuthUser`. **No database call** — the signature alone proves the token is authentic.
2. **`JwtAuthGuard`** (`jwt-auth.guard.ts`) — the *switch*. `@UseGuards(JwtAuthGuard)` on a route runs the strategy; a bad/expired/missing token → automatic **401**.
3. **`@CurrentUser()`** (`current-user.decorator.ts`) — the *reader*. A custom **parameter decorator** that pulls the identity into a handler argument cleanly.
4. **`GET /auth/me`** — a protected route that returns the current user, proving the chain works.

**The glue is `request.user`, not a direct link.** Passport takes whatever `validate()` returns and sets `request.user` on the request. `@CurrentUser()` just *reads* `request.user`. So the strategy is the **writer**, the decorator is the **reader**, and `request.user` is the shared drop-box between them — neither imports the other (easy to swap the strategy later).

- **Why a custom decorator?** So controllers don't repeat `@Req() req` → `req.user` everywhere and couple themselves to Express. You build one whenever a bit of per-request data (the user, their id, their tenant, their IP) is needed across many handlers.
- **`getOrThrow` for secrets:** we read `JWT_ACCESS_SECRET` with `config.getOrThrow(...)` so the app **crashes loudly at boot** if the secret is missing — never silently signs/verifies with `undefined`.
- **Stateless trade-off:** because we trust the token's contents, a role change won't take effect until the current access token expires (≤15 min). Accepted cost of not hitting the DB every request.

---

## Refresh rotation & logout

When the 15-min access token expires, the client sends its **refresh token** to `POST /auth/refresh` to get a new pair — without re-entering a password. Two methods on `TokensService`:

- **`rotate(rawRefreshToken)`**: hash the incoming token → look up the row by hash (pulling in user+role) → if missing, **401**; if expired, delete it and **401**; otherwise **delete the row** and mint a fresh pair via `issueTokens`.
- **`revoke(rawRefreshToken)`** (logout): hash it, `deleteMany` the matching row. Uses `deleteMany` so it's **idempotent** — logging out twice never errors.

**Single-use is the whole point.** A refresh token is deleted the instant it's used. So:
- Normal flow: client refreshes, gets a new token, old one is already gone — fine.
- Theft: if an attacker uses a stolen refresh token, the *real* user's next refresh finds no row → **401**, a visible tripwire. Only one of them can win the race, and the loser is forced to log in again.
- **Per-row = per-device:** each login/refresh is its own row, so "log out this device" deletes one row and "log out everywhere" deletes all the user's rows — surgical revocation.

**Why `POST` for logout, and 204?** Logout *changes server state* (deletes a row), so it's not a `GET`. There's nothing meaningful to return, so we reply `204 No Content`.

**Known limitation (future hardening):** we do plain single-use rotation. A stronger design adds **token families / reuse detection** — if a token that was *already rotated away* is presented, treat it as theft and revoke the user's whole family of tokens. Clean stretch enhancement; not built yet.

---

## TypeScript: the constructor shorthand (parameter properties)

- `constructor(private readonly prisma: PrismaService) {}` does **two things at once**: it *declares* a `this.prisma` field **and** *assigns* the incoming argument to it. The longhand would be a separate field declaration plus `this.prisma = prisma` in the body.
- It's triggered by putting an access modifier (`private` / `public` / `readonly`) on a **constructor parameter**. No modifier = an ordinary throwaway argument that is *not* stored on the instance.
- `private` = usable only inside the class; `readonly` = can't be reassigned after construction (a safety habit — you never want to swap out a dependency mid-life).
- **Pairs with NestJS DI:** you never call `new TokensService(...)`. Nest reads the constructor's parameter *types*, finds the matching provider in its registry, and passes the shared instance in. (It can see the types at runtime thanks to `emitDecoratorMetadata` + the `@Injectable()` decorator.) So this shorthand is exactly where "declare a dependency" and "store it" meet.

---

## async / await & Promises (and why the handlers differ)

- Anything that hits the **database, network, or disk** is asynchronous — it returns a **Promise**, a placeholder for a value that will be ready *later*.
- **`await`** = "pause here until this Promise finishes, then continue." A function that uses `await` must be marked **`async`**. An `async` function **always** returns a Promise (so a no-value one is typed `Promise<void>`).
- **Why `login`/`refresh` don't `await` but `logout` does:**
  - `login`/`refresh` have a value to send back, so they `return this.service.method(...)` — *returning the promise* hands the waiting job to NestJS, which resolves it and serialises the result to JSON.
  - `logout` has **nothing to return** (`204 No Content`). We still `await revoke(...)` so that (a) the row is actually deleted *before* we respond "logged out", and (b) a failed delete surfaces as a real HTTP error instead of a silent unhandled rejection. (`return this.tokensService.revoke(...)` would be equivalent — the `async/await` form just reads more explicitly.)
- **The bug to avoid — fire-and-forget:** calling `this.service.method()` with *neither* `await` *nor* `return` responds *before* the work finishes and swallows any error.
- **`@HttpCode(204)`:** a `POST` defaults to `201 Created` in Nest; logout creates nothing and returns no body, so we override to `204 No Content`.

---

## Prisma relations: relation field vs foreign key, and `include`

- A relation in `schema.prisma` is really **two different things**:
  - **`userId String`** — a *real column* in the database (the **foreign key**: it literally stores the related user's `id`).
  - **`user User @relation(...)`** — a **Prisma-only relation field**. It does **not** exist as a column; it's a logical pointer meaning "the row that `userId` refers to." `SELECT * FROM "RefreshToken"` shows `userId`, never `user`.
- **Relations aren't loaded unless you ask.** By default a query returns only the real columns, so `row.user` is `undefined`. You opt in with **`include`**:
  - `include: { user: true }` → fetch the related user, stop there. `user.role` would be `undefined` (you'd still have `user.roleId`, the FK column).
  - `include: { user: { include: { role: true } } }` → fetch the user **and** follow one more hop to its role. Now `user.role.name` exists. (This nested form is why `rotate` uses it — `issueTokens` needs `role.name`.)
- **Mental model:** `true` = "load this relation, don't go deeper"; `{ include: ... }` = "load it *and* keep drilling." You only pay for the JOINs you actually ask for.
- This is the ORM's core value: store a cheap foreign key, then *navigate* it to the full, typed object on demand — no hand-written `JOIN` SQL.

---

## When to build a custom decorator

- `@CurrentUser()` is a **custom parameter decorator** — it extracts a piece of the request and delivers it as a handler argument, cleanly and typed.
- **Reach for one when the same "dig something out of the request" would repeat across many handlers**, e.g.:
  - the logged-in user → `@CurrentUser()` (ours)
  - just their id → `@CurrentUserId()`
  - the client IP (behind a proxy header) → `@ClientIp()`
  - a tenant/org id from a subdomain or header → `@TenantId()`
- Without it you'd write `@Req() req` and poke at `req.user` / `req.headers[...]` in every handler — repetitive, untyped, and it couples your controller to Express. A decorator does that extraction **once**.
- **Don't bother** for a genuine one-off — just use `@Req()`.
- (Decorators come in families: **class** `@Controller()`/`@Injectable()`, **method** `@Post()`/`@UseGuards()`, **property** `@IsEmail()`, **parameter** `@Body()`/`@CurrentUser()`. The kind you *write yourself* most often is the parameter one.)

---

## Editor squiggles vs real errors (tooling)

- Red squiggles like **`Cannot find name 'jest' / 'describe' / 'expect'`** in `*.spec.ts` are usually a **false positive** — the editor's TS server resolves from the repo root, which isn't wired for Jest's types; the tests actually live under `backend/` and run fine there.
- **Source of truth:** `npm test` (does it run?) and `npx tsc --noEmit` (does it compile?). If those are clean, the squiggle is cosmetic — ignore it.
- Same story for the occasional `Property 'x' has no initializer` (2564) on DTO fields — the project's tsconfig doesn't enable that strict check; the `!` (definite-assignment assertion) we add just silences the editor.

---

## 🔑 Milestone 2 recap — authentication, end to end

The whole auth surface, and how a session lives and dies:

| Endpoint | Guard? | What it does |
|---|---|---|
| `POST /auth/register` | no | Create an account (bcrypt-hashed password, default `user` role). Returns the user *without* the hash. |
| `POST /auth/login` | no | Verify email + password → return `{ accessToken, refreshToken }`. |
| `POST /auth/refresh` | no* | Exchange a valid refresh token for a fresh pair (old one is burned). |
| `POST /auth/logout` | no* | Revoke (delete) a refresh token → `204`. |
| `GET /auth/me` | **yes** | Return the caller's identity from their access token. |

\* `/refresh` and `/logout` aren't behind the JWT guard on purpose — you use them precisely when the access token is expired/gone. They authenticate via the *refresh token in the body*, not the access-token header.

**The session lifecycle:**
1. **Login** → server signs a 15-min access JWT and stores a hashed 7-day refresh-token row. Client holds both.
2. **Every request** → client sends `Authorization: Bearer <access>`. `JwtStrategy` verifies the signature + expiry (no DB) and populates `request.user`.
3. **Access token expires (~15 min)** → next request `401`s. Client calls `/refresh` with its refresh token → gets a new pair; the old refresh row is deleted (single-use).
4. **Logout** → client calls `/logout`; that refresh row is deleted, so it can never refresh again.

**The security principles this milestone demonstrates (interview-ready):**
- **Two tokens, two jobs** — short-lived stateless access (small blast radius: a stolen access token dies in ≤15 min and can't renew itself) + long-lived stateful refresh (revocable, single-use).
- **Never store the sensitive form** — passwords as bcrypt (slow+salted), refresh tokens as SHA-256 (fast lookup); the raw refresh token exists only on the client.
- **Deny attackers signal** — identical vague `401` for bad-email vs bad-password, *and* constant-time login (a dummy bcrypt compare) so timing can't leak which emails exist.
- **Fail loud on misconfig** — `getOrThrow` on the JWT secret: the app refuses to boot rather than run insecure.
- **Rotation as a tripwire** — single-use refresh tokens mean a stolen-and-reused token gets caught (whoever presents it second is denied).

**Deferred hardening (noted for later, not built):** refresh-token *reuse detection with families*; atomic `rotate` (delete-as-gate) for concurrent-refresh safety. Both are good "how would you harden this?" talking points.

---

## Authentication vs authorization (401 vs 403)

Two different questions, two different guards, and they run in a fixed order:

- **Authentication — "who are you?"** — `JwtAuthGuard`. Missing / malformed / expired token → **`401 Unauthorized`**. Identity is *unknown*.
- **Authorization — "are you allowed to do this?"** — `PermissionsGuard`. Identity is known, but the action is refused → **`403 Forbidden`**.

The guard order is always `@UseGuards(JwtAuthGuard, PermissionsGuard)` — authenticate *first*, because authorization is meaningless until you know who's asking. `JwtAuthGuard` puts the caller on `request.user`; `PermissionsGuard` reads it. Flip the order and the second guard has nothing to check.

The clearest way to feel the difference: hit `GET /users` three ways —
- no token → **401** (we don't know who you are),
- a self-registered `user`-role token → **403** (we know exactly who you are; you just may not),
- an admin token → **200**.

Same endpoint, outcome decided purely by *who is asking*. That is RBAC.

---

## Why the guard reads the DB, not the token

This was the central design decision of the milestone. When a route needs a permission, where does the guard get the caller's permissions from?

| Option | Where permissions come from | Problem |
|---|---|---|
| **A** | Baked into the JWT at login | A signed token **can't be un-issued**. Suspend or demote a user and their token keeps its old power until it expires (≤15 min). |
| **B** ✅ | **DB lookup every guarded request** (`user → role → permissions`) | One extra query per request. That's it. |
| **C** | DB + short-TTL cache | Faster, but re-introduces A's staleness for the cache window. |

We chose **B**: correctness over speed, because this is the mechanism guarding money movement. A JWT is a *signed claim frozen at login* — nothing can reach back and change what it says. So we ignore what the token claims about role/permissions and ask the database, which is always current.

**The proof (run live in Task 4):** promote a customer to admin, mint them a fresh token, confirm `200` on `/users`. Then an admin suspends them. The **same unexpired token**, one request later → **`403 Account suspended`**. The token still says `role: admin` and is nowhere near expiry — the guard just didn't care, because it asked Postgres. Under option A that user keeps admin access for another 15 minutes. *That* instant-revocation is what option B buys.

(The token's `role` claim is still used for cheap things like `@CurrentUser().role` in separation-of-duties checks — but never as the source of truth for *what you're allowed to do*.)

---

## `SetMetadata` + `Reflector` — a decorator that does nothing, and a guard that reads it

RBAC enforcement is split into a **tag** and a **reader** that never call each other — they communicate through NestJS's metadata store:

- **`@RequirePermissions('user.manage')`** is built on `SetMetadata`. It runs **once, at startup**, when Nest scans controllers, and does exactly one thing: pins `'requiredPermissions' → ['user.manage']` onto that route. **Zero logic.** A sticky note on the door.
- **`PermissionsGuard`** runs **before every request**. Nest hands it a `Reflector` — the tool to *read back* that metadata:

  ```ts
  const required = this.reflector.getAllAndOverride(PERMISSIONS_KEY, [
    context.getHandler(),   // the method's metadata
    context.getClass(),     // the controller's metadata
  ]);
  ```

  `getAllAndOverride` reads **both** levels and lets the **handler win**. That's what makes a class-level `@RequirePermissions('user.manage')` a *default* that a single route can override — put a stricter tag on one method and it takes precedence. No metadata at all → the guard returns `true` and never touches the DB (that route simply isn't its business).

This mirrors M2's `@CurrentUser`, in the opposite direction:

| | `@CurrentUser` (M2) | `@RequirePermissions` (M3) |
|---|---|---|
| When it runs | every request | once, at startup |
| What it does | **reads** the request (`request.user`) | **writes** metadata onto the route |
| Who consumes it | it *is* the reader | `PermissionsGuard` reads it back |

Same decorator machinery, one reads at call time, the other writes at definition time.

---

## Separation of duties (the two rules that make it real)

`user.manage` lets an admin edit any user — which is a back door unless you close two holes. The rules live in `UsersService.updateRole`/`updateStatus`, *not* in a guard, because they depend on the *relationship* between actor and target, not just the actor's permission:

1. **You cannot change your own role.** Without this, an `admin` (who holds `user.manage`) promotes *themselves* to `super_admin` and inherits every permission in the system — including `withdrawal.approve`, deliberately withheld from admins. Self-promotion is the classic privilege-escalation move; this closes it.
2. **Only a `super_admin` may assign the `super_admin` role.** Blocking self-promotion is pointless if the admin can just crown an accomplice instead. This blocks the sideways version.
3. (Plus a self-lockout guard: you can't suspend yourself.)

**What is *deliberately allowed*:** an `admin` assigning someone the `finance` role, thereby granting `withdrawal.approve` — a permission the admin doesn't personally hold. That's **delegation**, and it's a legitimate, intended operation (a manager staffing a team), not an escalation (the admin gains nothing themselves). It is *audited* (M5), not blocked. The line: you may grant others powers you lack; you may not grant *yourself* power, nor mint another top-level admin.

---

## What a refactor actually is (Task 1)

Task 1 moved all user/role DB access out of `AuthService` into new `UsersService`/`RolesService`. Structure changed; behaviour didn't. The tell that it was faithful:

- **Assertions did not change.** Every `expect(...)` in `auth.service.spec.ts` stayed byte-for-byte identical — because they describe *behaviour*, and a refactor changes none.
- **Mock wiring *did* change** — from a `PrismaService` mock to `UsersService`/`RolesService` mocks — because `AuthService`'s *collaborators* changed.

The lesson: **mock-based unit tests are coupled to *who a class talks to*.** Rewiring a mock when collaborators change is routine. But if you ever find yourself editing an *assertion* during a "refactor," stop — behaviour drifted, and that's no longer a refactor.

---

## Deliberate non-goals in M3 (and why)

Scope discipline is a skill; here's what we *chose not to build* and the reasoning:

- **No roles/permissions CRUD.** They're seed data. An endpoint to edit them is a privilege-escalation vector (create a role with every permission, assign it to yourself) for near-zero benefit. Read-only `GET /roles` only, to populate a future dropdown.
- **No permission caching (option C).** It trades correctness for a performance problem we don't have at this scale, and re-introduces the staleness we rejected option A to avoid. Premature.
- **No refresh-token revocation on suspend.** A suspended user's *refresh* token still technically works — but it's harmless, because `PermissionsGuard` reads status from the DB on every request, so any action is still `403`-ed instantly. The clean fix (revoke refresh rows on suspend) forces a circular module dependency (`TokensService` → `AuthModule` → `UsersModule` → …) for a hole nothing can currently exploit. Deferred to M4.

---

## 🔑 Milestone 3 recap — authorization, end to end

The admin surface and how a request is judged:

| Method | Path | Permission | Who can call it |
|---|---|---|---|
| `GET` | `/users` | `user.manage` | admin, super_admin |
| `GET` | `/users/:id` | `user.manage` | admin, super_admin |
| `GET` | `/roles` | `user.manage` | admin, super_admin |
| `PATCH` | `/users/:id/status` | `user.manage` | admin, super_admin (not on self) |
| `PATCH` | `/users/:id/role` | `user.manage` | admin (super_admin role: super_admin only; not on self) |

**The request lifecycle** (`Authorization: Bearer <access>` → handler):

1. **`JwtAuthGuard`** intercepts. Delegates to **`JwtStrategy`**, which verifies the JWT signature + expiry (no DB) and returns a clean `AuthUser` (`{ id, email, role }`).
2. Nest puts that `AuthUser` on **`request.user`**. Bad/missing/expired token → **`401`**, and the request never reaches the next guard.
3. **`PermissionsGuard`** runs. Reads the route's required permissions via `Reflector.getAllAndOverride`. No permission required → allow. Otherwise it **queries the DB** by `request.user.id` for the live `user → role → permissions`.
4. It rejects with **`403`** if: the user vanished, `status !== 'active'` (`Account suspended`), or any required code is missing. Otherwise → allow.
5. The **handler** runs, calls a `UsersService` method, and every user-shaped result passes through **`toSafeUser`** so no `passwordHash` ever leaves.

**The principles this milestone demonstrates (interview-ready):**
- **Authorization is live, not frozen** — read authority from the DB each request, because a signed token can't be un-issued. Instant revocation is the payoff.
- **401 ≠ 403** — unknown identity vs known-but-refused; two guards, fixed order.
- **Least privilege + separation of duties** — permissions attach to roles, not users; and even a permission-holder can't escalate *themselves* or mint a peer.
- **Delegation is not escalation** — granting others a power you lack is legitimate and audited; granting *yourself* power is blocked.
- **One owner per table** — all `prisma.user` access lives in `UsersService`, all `prisma.role` in `RolesService`; nothing else touches those tables, so the "never leak the hash" rule has exactly one place to hold.

**Deferred hardening (noted, not built):** refresh-token revocation on suspend (blocked by a circular dependency, harmless for now — see non-goals); permission caching; ownership-gating for customer-facing routes (that's M4, where `deposit.approve` / `withdrawal.approve` finally get consumed).

---

## Money is an integer, never a float

`0.1 + 0.2 === 0.30000000000000004` in JavaScript. Floats are binary fractions and cannot represent most decimal amounts exactly, so every arithmetic step accumulates a tiny error. In a ledger those errors compound and the books stop balancing — a fatal flaw in finance.

The fix is universal in payments: **store money as an integer in the currency's smallest unit** ("minor units"). `RM 100.00` is stored as `10000` (sen). `Int` in Prisma, `INTEGER` in Postgres, whole numbers everywhere. You divide by 100 only at the last moment, for display.

Two supporting rules we enforce:
- **`amount` is always positive.** Direction comes from `type` (`deposit` / `withdrawal` / `adjustment`), never from a minus sign. Signed amounts invite the bug where a "deposit of -500" quietly becomes a withdrawal that skipped every withdrawal check.
- **Floats are rejected at the boundary.** `@IsInt()` on the DTO means `{"amount": 10.5}` gets a `400` before it reaches any logic. Money never enters the system in a form that could round.

## The immutable ledger (append-only)

`Wallet.balance` is a **derived cache**, not the truth. The truth is the `Transaction` table, and rows there are **appended, never edited or deleted**.

- Made a mistake? You don't edit the wrong row — you append a **new `adjustment` row** that corrects it. The error stays visible, and so does the correction. That's what "auditable" means.
- Every **settled** row records `balanceBefore` and `balanceAfter`. Read them in order and they form an unbroken chain:

```
0 → 10000 → 0 → 5000        and  wallet.balance = 5000  ✅
```

Each row's `after` is the next row's `before`. That lets you **recompute the balance from the ledger alone** and prove the `Wallet` table isn't lying — exactly what a reconciliation job or an auditor does. A mismatch means something wrote to `balance` outside the settlement path.

- `pending` and `rejected` rows carry `null` for both. They're a record of *what was asked and what was decided*, without participating in the arithmetic.

## Two phases: requesting ≠ settling

`POST /wallets/:id/deposits` creates a `pending` row and **moves no money**. Nothing changes a balance until a `finance` user approves it. Proof from the live run: a pending deposit of `10000` sat in the ledger while the wallet still read `balance: 0`.

This is also why there are **two different balance checks** for a withdrawal, and confusing them is a classic bug:

| | At request time | At settlement |
|---|---|---|
| Purpose | **UX** — don't let a customer file a doomed request | **Correctness** — protect the invariant |
| Authoritative? | **No** | **Yes** |
| Why | the balance can change before approval | it runs under a row lock, on the true current balance |

Never let the friendly check stand in for the real one.

## 🔒 The heart of it: settlement, races, and pessimistic locking

**The race.** Two finance users open the pending queue. Both see the same withdrawal of `10000` against a balance of `10000`. Both click approve within the same millisecond. Naively:

```
A: read balance = 10000     B: read balance = 10000
A: 10000 >= 10000 ✅        B: 10000 >= 10000 ✅
A: write balance = 0        B: write balance = 0
```

Both checks passed against the *same stale read*. The customer withdrew `20000` from a wallet holding `10000`. This is the **double-spend**, and no amount of careful `if` statements in JavaScript fixes it — the gap between "read" and "write" is where the other request slips in.

**Two distinct invariants, two distinct guards.** It's tempting to think the balance check covers everything. It doesn't:

| Invariant | Check | Failure |
|---|---|---|
| A request settles **at most once** | `txn.status !== 'pending'` | **409** Conflict |
| A balance is **never negative** | `before < txn.amount` | **400** Bad Request |

Approve a `10000` withdrawal twice against a `30000` balance and the funds check passes *both* times — yet one request debited `20000`. Different failure, different guard. Neither substitutes for the other.

**The fix: pessimistic row locking.** Everything happens inside one `prisma.$transaction(async (tx) => …)`, and the first thing we do is take a lock:

```sql
SELECT id FROM "Transaction" WHERE id = $1 FOR UPDATE
```

We throw the result away — reading the `id` is pointless. The **side effect is the whole point**: Postgres marks that row locked, and any other transaction issuing `FOR UPDATE` on the same row **blocks** until we commit or roll back. So request B doesn't get a stale read; it gets *no read at all* until A finishes. When B finally proceeds, A has already flipped `status` to `approved`, so B's own status check fires → `409`.

The lock turns "check, then subtract" from two separate steps into one **indivisible** operation. That's the definition of atomicity, and it can only be enforced by the database — the only component that sees all the concurrent requests at once.

**Always re-read inside the lock.** The approver's browser showed a balance fetched seconds ago; that number is already stale. Settlement ignores it, ignores the request-time check, and reads the true current balance *after* taking the lock. Anything read before the lock may have changed.

**Fixed lock order: transaction row, then wallet row.** Always that sequence, everywhere. If one code path locked wallet→txn while another locked txn→wallet, two requests could each hold what the other is waiting for — a **deadlock**, where both stall until the database kills one. A globally consistent lock order makes that impossible. It costs nothing today and is what saves us in M4c, when a transfer must lock *two* wallets (order them by id, always).

**Don't do unrelated I/O while holding a lock.** Found and fixed in the M4a review: the permission check originally ran *inside* the transaction, and it reads through the root Prisma client — borrowing a **second connection from the pool while holding the first**. With enough concurrent approvals (the pool defaults to roughly `cpus × 2 + 1`), every transaction holds one connection and waits for another that never comes: a pool-starvation deadlock. It also held the row lock across an extra network round-trip. The fix: run it *before* the transaction opens, using `type` — which is written once and never changes. Everything **mutable** (`status`, `balance`) is still re-read under the lock. General rule: **hold locks for as short a time as possible, and do nothing under them that isn't strictly necessary.**

**The proof (real Postgres, not a mock).** One pending withdrawal for the full balance, four approvals fired simultaneously:

```
1:200  2:409  3:409  4:409      balance: 5000 → 0
```

Exactly one winner, three refused, debited exactly once. This is the single most valuable demo in the project — most systems *claim* concurrency safety and can't show it.

**Honest caveat:** that proof is a **manual curl demo**, not an automated test. The unit tests exercise the *logic* against a mocked `tx` where `$queryRaw` is a no-op — so `npm test` would **not** catch someone deleting the `FOR UPDATE` lines. A real integration harness against a dedicated test database is deferred (see below). Knowing what your tests *don't* cover is part of the job.

## `tx` vs `this.prisma` — the most dangerous typo in the file

A database transaction lives on **one specific connection**. `BEGIN`, your statements, `COMMIT` — all on the same wire. Postgres has no idea that two connections are "related".

```
this.prisma  →  the connection POOL  →  hands you *any* free connection
tx           →  THE one connection holding the open BEGIN
```

So inside `$transaction(async (tx) => …)`:

```typescript
await tx.wallet.update(...)           // ✅ inside the transaction
await this.prisma.wallet.update(...)  // ❌ different connection — OUTSIDE it
```

That second line would break the system three ways:
- **It ignores the locks.** `FOR UPDATE` protects `tx`'s connection. A write on another connection isn't covered by it, so the double-spend race comes straight back.
- **It won't roll back.** If a later line throws, Prisma rolls back `tx`'s work — but the `this.prisma` write already committed on its own. Result: a debited wallet with no ledger row. A corrupted book, the exact failure this whole design exists to prevent.
- **It can deadlock against itself.** `this.prisma` waits for a row that `tx` has locked, while `tx` waits for `this.prisma` to finish. One request, two connections, stuck forever.

**Rule: once you're inside the callback, `tx` is the only client you may touch.** Every line in `approve`/`reject`/`adjust` uses `tx.` — that's load-bearing, not stylistic.

## Which reads can happen *before* the lock

The same connection fact explains the Task 6 refactor. `assertApprovePermission` calls `UsersService`, which uses *its own* `this.prisma` — a **second connection taken while holding the first**. With a pool of ~`cpus × 2 + 1` (say 9), nine concurrent approvals take all nine connections, then each asks for a tenth that doesn't exist, and each waits on a connection held by a peer that is also waiting. Everything stalls until the 5s transaction timeout kills it. It only appears under concurrency — never in dev.

Moving it out is safe because of **mutability**, and that's the general test:

| Column | Mutable? | Read where |
|---|---|---|
| `type` | written once at request time, never changes | **before** the lock ✅ |
| `status` | changes at settlement — the whole point | **under** the lock, always |
| `balance` | changes at settlement | **under** the lock, always |

`type` has no writer, so there's nothing to race against: reading it early gives the same answer as reading it late. `status` and `balance` are re-read under the lock, every time.

> **Do the expensive, unrelated, immutable-data work outside the lock. Hold the lock only for what can change under you.**

## Why `async (tx) => { … }` needs its own `async`

`$transaction` takes a **function**, not a value, because Prisma needs to wrap your code:

```
Prisma:  BEGIN
Prisma:  ─── calls your callback, handing it tx ───
you:        lock, read, check, update, update
Prisma:  COMMIT        (or ROLLBACK if you threw)
```

The callback's *shape* is the transaction's boundary — you never write `BEGIN`/`ROLLBACK` yourself. It's also why throwing anywhere inside is a clean abort: Prisma catches it, rolls back, and rethrows so Nest converts it to the right 400/404/409.

`async` is **not inherited** from an enclosing function. It belongs to whichever function directly contains the `await`s — and here there are two functions with two sets of awaits:

```typescript
async approve(...)            // ← awaits getSettleableType
  return this.prisma.$transaction(
    async (tx) => {           // ← a separate function, awaits tx.$queryRaw
      await tx.$queryRaw`...`
    }
  )
```

Nesting isn't redundancy. And note `approve` **returns** the `$transaction` promise: it resolves only once the transaction has actually **committed**, and the callback's return value becomes the method's result. That's why the HTTP response can never show an `approved` row that didn't commit.

## Ownership-gating vs permission-gating (two different questions)

M4a introduces a second authorization mechanism alongside M3's:

| | Permission-gating (M3) | Ownership-gating (M4a) |
|---|---|---|
| Question | "does my **role** allow this kind of action?" | "is this **record** mine?" |
| Inputs | the caller alone | the caller **+ the loaded row** |
| Lives in | a **guard** (`PermissionsGuard`) | the **service** (`wallet.userId === actor.id`) |
| Reusable | yes, on any route | no — depends on each route's data shape |

Two shapes of ownership scoping, both used:
- **Filter** — `listWallets` uses `where: { userId: actor.id }`. Another user's wallets simply aren't in the result set; no `403` is even possible.
- **Fetch-then-check** — `getWallet` loads by id and compares. Missing → `404`, someone else's → `403`.

`listTransactions` calls the ownership check **before** reading any transactions, and a test asserts `transaction.findMany` was never called for a non-owner. That's the test that catches the classic leak of doing the work first and checking permission afterwards.

**Calling a check for its exceptions, not its value.** `requestDeposit` does `await this.getOwnedWallet(id, actor);` and discards the result — the tell that it's being called for its *throws*. (`requestWithdrawal` writes `const wallet = …` because it actually needs `wallet.balance`.) Delete that line and two things break:

1. **Someone else's wallet would work.** `walletId` comes from the **URL** — attacker-controlled input — not from the token. Postgres is happy; the FK is valid. You'd have written a pending transaction against a stranger's wallet, sitting in the finance queue waiting to be approved. Nothing downstream catches it: the approver checks *permissions*, not "was this request legitimately raised by the owner". The forgery would settle.
2. **A missing wallet returns 500 instead of 404.** `transaction.create` would hit a foreign-key violation (`P2003`), and with no handler Nest reports a 500. A bad *request* misreported as a broken *server*.

> **Validate a caller-supplied id against the caller before writing anything derived from it.**

The `await` is also load-bearing: drop it and the check returns an un-awaited promise, execution falls through to `create`, the row is written, and the rejection surfaces later as an unhandled rejection. A missing `await` in front of an authorization check is a silent security hole — which is why `@typescript-eslint/no-floating-promises` is worth enabling (M7).

Note that even `super_admin` gets `403` on `/wallets/:id` — customer routes are owner-scoped, full stop. Staff use the finance routes, which are permission-gated and audited. Separating those doors is itself an audit control.

**Why the type-specific approve check can't be a guard.** The deciding test is: *can you name the required permission before loading any row?*

```
adjust   → always 'wallet.adjust'                        ← constant, known at startup
approve  → 'deposit.approve' OR 'withdrawal.approve'     ← depends on txn.type
```

`@RequirePermissions('wallet.adjust')` is `SetMetadata` — it runs **once when the class is defined** and staples a constant onto the route forever. It cannot say "whichever code matches a row we haven't fetched." So `approve` *couldn't* use it. This is the same principle as M3's separation-of-duties rules, which compare the actor to the loaded target user.

Three further reasons data-dependent checks don't belong in guards:
1. **Double-fetch** — the guard loads the row, then the service loads it again. Stashing it on `request.wallet` works but makes the service silently depend on a guard having run, with no compile error if it's removed.
2. **Guards run before pipes.** Nest's order is `middleware → guards → interceptors → pipes → handler`, so a guard sees raw unvalidated params — `ParseUUIDPipe` hasn't run yet.
3. **Guards run before the transaction exists.** Anything a guard checked could be stale by settlement time — precisely the race locking exists to close.

> **Guard when the permission is a constant. Service when it depends on the data.**

**Guards stack.** `/wallets/:id/adjustments` carries a method-level `@UseGuards(PermissionsGuard)` **on top of** the controller's class-level `JwtAuthGuard`; Nest runs both. Other routes on that controller run only the class guard — and `PermissionsGuard` is a no-op on routes without `@RequirePermissions` (it returns `true` without touching the DB), which is what makes stacking safe.

## POST vs PATCH (and why `approve` returns 200)

The deciding test is **idempotency** — does calling it twice differ from calling it once?

| | `PATCH /users/:id/status` | `POST /wallets/:id/adjustments` | `POST /transactions/:id/approve` |
|---|---|---|---|
| What it does | edits a field on an existing thing | **creates** a new ledger row | performs an **action** |
| Called twice | identical result | money moves **twice** | first `200`, second **`409`** |
| Idempotent | yes | no | no |

- **PATCH** = partial update of an existing resource; send only the changed fields.
- **POST** = create a subordinate resource, or trigger a non-idempotent action. The plural noun (`/adjustments`, `/deposits`) is a collection you're appending to. A UI must never blindly auto-retry a POST.

`approve` is a **state-machine transition with side effects**, not a field edit — `PATCH {status:"approved"}` would invite the client to think it's just setting a column, when it actually runs settlement under locks. Its non-idempotency is deliberate: the second call *must* `409`.

Caught in review: Nest returns **201 Created** for POST by default, but approving creates nothing from the client's view — it settles an existing request. Both settle routes now use `@HttpCode(200)`. The request and adjustment routes genuinely do create rows, so `201` is correct there.

## Direct adjustments — a deliberate control weakness

`POST /wallets/:id/adjustments` lets finance credit or debit **any** wallet with no request phase (chargeback reversal, goodwill bonus, correcting an operational error). It's permission-gated, not owner-gated — which is why a customer gets `403` adjusting *their own* wallet. Owning a wallet doesn't let you print money into it; ownership and privilege are orthogonal questions.

Here `requestedBy === reviewedBy`: one person both raises and settles it. That is genuinely the weakest control in the system, and it exists because real operations need it. It's mitigated three ways — a narrow permission (`wallet.adjust`), a **mandatory** `note` (`@MinLength(1)`, so no silent money movement), and M5's audit log. A regulated shop would add maker-checker above a threshold. Naming a known gap beats pretending it isn't there.

The invariant still holds: a debit cannot drive the balance below zero, and it takes the same wallet lock. Privileged ≠ unconstrained.

## Deliberate non-goals in M4a (and why)

- **No transfers, no FX, no KYC yet.** The M4 family is ordered by dependency: **4a core ledger → 4b KYC → 4c transfers → 4d currency conversion**. A transfer is two settlements against one another, and FX is a transfer with a rate — neither can be built before settlement is solid. KYC comes second because it's the *same* request → review → approve shape built here, so it reuses a pattern you already understand, and the money routes then gain a verified-only gate (like a real e-wallet).
- **No ledger mutation.** No edit or delete endpoints for transactions, ever. Corrections are new rows.
- **No FK on `requestedBy` / `reviewedBy`.** Plain userId strings. Making them relations needs two *named* relations plus back-references on `User`, all for a query M4a never runs. YAGNI.
- **`403` vs `404` leaks existence.** Returning them distinctly lets someone probe which wallet ids exist. Accepted for now — ids are uuidv4, so guessing is infeasible — but a uniform `404` is the hardening move, noted not built.
- **No pagination on the finance queue.** `GET /transactions/pending` and `GET /wallets/:id/transactions` return everything, unlike `GET /users` which caps `take` at 100. Fine at demo scale, a real problem after a year of traffic. Recorded as deferred rather than bolted on during a review pass.

---

## 🔑 Milestone 4a recap — the ledger, end to end

| Method | Path | Gate | Who can call it |
|---|---|---|---|
| `POST` | `/wallets` | authenticated | any user (owner forced from the token) |
| `GET` | `/wallets` | authenticated + **filter** | any user — sees only their own |
| `GET` | `/wallets/:id` | authenticated + **ownership** | the owner only (`403` even for super_admin) |
| `GET` | `/wallets/:id/transactions` | authenticated + **ownership** | the owner only |
| `POST` | `/wallets/:id/deposits` | authenticated + **ownership** | the owner — creates a `pending` row |
| `POST` | `/wallets/:id/withdrawals` | authenticated + **ownership** | the owner — creates a `pending` row |
| `GET` | `/transactions/pending` | `transaction.view_all` | finance, admin, support |
| `POST` | `/transactions/:id/approve` | `view_all` **+** type-specific in service | finance, super_admin |
| `POST` | `/transactions/:id/reject` | `view_all` **+** type-specific in service | finance, super_admin |
| `POST` | `/wallets/:id/adjustments` | `wallet.adjust` | finance, super_admin |

Four routes, four genuinely different authorization questions — and every check that depends on row data lives in the service.

**The money-movement lifecycle:**

1. **Request.** Owner posts a deposit/withdrawal. Ownership verified, amount validated as a positive integer, friendly balance pre-check on withdrawals. A `pending` row is written. **No balance changes.**
2. **Review.** A finance user lists `/transactions/pending`. An `admin` can *see* this queue but **cannot approve** — viewing and approving are separate privileges, so an admin-level compromise can't drain wallets.
3. **Settle.** `approve` checks the type-specific permission, then opens one DB transaction: lock the txn row → re-read it → `409` if not `pending` → lock the wallet row → read the true balance → `400` if a withdrawal would go negative → update the balance → stamp the row `approved` with `balanceBefore`/`balanceAfter`, `reviewedBy`, `reviewedAt`. All or nothing.
4. **Or reject.** Same locks and the same `409` guard, but no money moves. The row stays forever as a record of the decision.

**Interview-ready principles:**
- **Integers for money, direction in the type** — floats can't represent decimals exactly, and signed amounts hide bugs.
- **The ledger is the truth; the balance is a cache** — append-only, and the `before`/`after` chain lets you prove the cache is honest.
- **Concurrency safety is a database property, not a code property** — `FOR UPDATE` inside a transaction makes check-then-write indivisible; a fixed lock order pre-empts deadlock; hold locks briefly and do no unrelated I/O under them.
- **Two invariants, two guards** — settle-at-most-once (`409`) and never-negative (`400`); neither implies the other.
- **Authorization has two shapes** — constant permission → guard; data-dependent → service.
- **Name your weak controls** — self-approved adjustments are the soft spot, mitigated by a narrow permission, a mandatory reason, and an audit trail to come.

**Deferred (noted, not built):** integration-test harness against a real test DB (so the locking is covered by `npm test`, not just a curl demo); pagination on the finance queue and wallet history; uniform-`404` hardening; maker-checker on large adjustments; refresh-token revocation on suspend (still carried from M3); transfers (M4c), FX (M4d), KYC gating (M4b).

---

# Milestone 4b — wallet-to-wallet transfers

## Deterministic lock ordering — why sorting the two ids kills deadlock

M4a locked one wallet at a time. A transfer touches **two**, and that is where a new failure mode appears: **deadlock**.

Picture two transfers running at the same instant:

```
Alice → Bob      needs to lock wallet A, then wallet B
Bob   → Alice    needs to lock wallet B, then wallet A
```

If each locks **its own sender first**, the interleaving that ruins you is:

```
Alice→Bob  locks A ✓ … now waits for B
Bob→Alice  locks B ✓ … now waits for A
```

Each holds exactly what the other is waiting for, and neither will ever let go. That is a **deadlock** — a cycle in the "who-waits-for-whom" graph. Postgres detects the cycle and kills one transaction as a victim (`40P01 deadlock_detected`), which surfaces to the client as a `500`.

The fix is almost too simple: **don't lock sender-first — lock in a fixed, direction-independent order.** Sort the two ids and always lock the smaller one first:

```typescript
const [firstLock, secondLock] = [fromWalletId, dto.toWalletId].sort();
await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${firstLock} FOR UPDATE`;
await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${secondLock} FOR UPDATE`;
```

Now **both** transfers — Alice→Bob and Bob→Alice — try to lock the *same* wallet first (whichever id sorts lower). One wins and proceeds; the other simply **queues** on that first lock and waits its turn. There is no cycle to form, so deadlock becomes *impossible*, not merely rare. The live proof (40 crossing transfers, zero `500`s) demonstrates it.

**Two separate `FOR UPDATE` statements, not `WHERE id IN (a, b) ORDER BY id`.** It's tempting to lock both rows in one query. Don't: Postgres locks rows in the order the **query plan** yields them, which is *not* guaranteed to follow your `ORDER BY`. Two sequential statements are provably ordered — the first fully completes before the second begins.

**Self-transfer is rejected (`400`) before the transaction even opens.** Locking one row twice is meaningless, and the arithmetic (`balance - amount`, then `balance + amount` on the *same* wallet) would be nonsense.

## Why this race yields `400`, not `409`

In M4a, the danger was **double-settlement** — approving the same pending request twice — caught by re-reading `status` under the lock and throwing `409` if it wasn't `pending`. You might expect the concurrent-drain race here to behave the same way. It doesn't, and the reason is worth internalising: **the two invariants are independent.**

- **Settle-at-most-once (`409`)** protects a *shared pending row*. A transfer has **no pending row** — it settles instantly and each transfer is its own independent event. There is nothing to "settle twice", so this guard simply does not apply.
- **Never-negative (`400`)** protects a *balance*. When two transfers of 5000 hit a wallet holding 5000, the loser isn't re-settling anything — it's trying to *spend money that isn't there*. The `from.balance < amount` check under the lock catches it and throws `400`.

Same lock, same wallet, but a different invariant is doing the work — so a different status code is correct. The live proof shows exactly one `201` and one `400`, final balance `0`, never `-5000`.

## Double-entry in the ledger — one movement, two rows

A transfer writes **two** `Transaction` rows, not one:

```
sender   wallet A:  transfer_out  amt=2500  before=100000  after=97500   transferId=T1  counterparty=B
receiver wallet B:  transfer_in   amt=2500  before=100000  after=102500  transferId=T1  counterparty=A
```

Why two rows instead of a single row with a `from` and a `to`? Because M4a's core property must survive: **every `Transaction` belongs to exactly one wallet, and every wallet's `balanceBefore → balanceAfter` chain must stay unbroken and recomputable from its own rows alone.** A single shared row physically cannot record a before/after for *two* wallets — one side's chain would have a gap. So each wallet gets its own row, its own honest chain entry.

The two halves are tied together by a shared **`transferId`** (a `randomUUID()` minted before the transaction) — that's what proves they are one event rather than two coincidental rows. `counterpartyWalletId` points the opposite way on each side, so a row is self-describing without a second query. No `Transfer` table is needed: the shared id gives the linkage at zero schema cost, exactly as `requestedBy`/`reviewedBy` are plain strings.

Both rows are written `status: 'approved'` and stamped with the **sender's** id as both `requestedBy` and `reviewedBy` — the sender initiated the movement, and the receiver reviewed nothing.

## Asymmetric authorization — and why no new permission

The two wallets are checked **differently**, on purpose:

| Wallet | Check | Reasoning |
|---|---|---|
| **Source** | ownership (`getOwnedWallet`) | you may only send *your own* money |
| **Destination** | existence only — no ownership check | it belongs to someone else; that is what a transfer *is* |

No `transfer.*` permission exists in the seed, and none is needed. Moving your own money is a **capability of ownership**, not a privilege a role grants — so this is pure ownership-gating (the M4a mechanism), with no guard involved. Contrast `adjust`, which touches *anyone's* wallet and therefore *does* need a permission (`wallet.adjust`). The question "do I need a permission?" comes down to "am I acting on something that's mine, or on the system at large?"

## Response privacy — decide what *leaves*, not just what's stored

The endpoint returns **only the sender's `transfer_out` row**. The receiver's `transfer_in` row carries *their* `balanceBefore`/`balanceAfter` — i.e. their account balance — and returning it would leak that to anyone able to send them money. You may hand someone funds; you may not learn what they hold.

This is the same instinct as `toSafeUser` back in M2: security isn't only about what you *store*, it's about what you let *leave* in a response. Here the whole pair is written to the database (both parties need their history), but only one half is returned to the caller.

## Deliberate non-goals in M4b (and why)

- **Cross-currency transfers → M4c.** Rejected with `400` here rather than silently converting at 1:1 — a wrong conversion is worse than a refusal.
- **Reversals / disputes.** The ledger is append-only; a reversal is a *new opposing pair*, which needs its own design (who authorises it, against which original). Not a `DELETE`.
- **Recipient lookup by email.** Needs a primary-wallet rule (a user may own several) plus account-enumeration hardening — a separate problem. Using a wallet id keeps this milestone on the actual hard part: two-wallet locking.
- **Transfer limits, velocity checks, fraud rules.** Real risk controls, but a distinct subsystem.
- **Threshold-based approval** (instant below a limit, review above). The most realistic model for a regulated operator and a good later enhancement — but it means building both the instant and the approval paths at once.
- **Blocking transfers to a suspended recipient.** Deliberately *allowed*. Refusing would leak the recipient's account status to the sender, and a frozen account still *holds* inbound funds rather than bouncing them — which matches how real platforms behave.

## 🔑 Milestone 4b recap — transfers, end to end

One new endpoint on the existing wallets controller:

| Method | Path | Gate | Who can call it |
|---|---|---|---|
| `POST` | `/wallets/:id/transfers` | authenticated + **ownership of source** | the source owner — destination need only exist |

**The transfer lifecycle:**

1. **Validate cheaply, outside the lock.** Reject self-transfer (`400`); confirm the caller **owns the source** (`403`/`404`). Both are immutable facts, safe to check before opening a transaction — and doing so means no lock is wasted on a doomed request.
2. **Lock both wallets in sorted-id order.** Two separate `SELECT … FOR UPDATE` statements, smaller id first, so concurrent opposite-direction transfers can never deadlock.
3. **Re-read under the locks.** Only now are the two balances trustworthy. Verify same currency (`400`) and sufficient funds (`400`).
4. **Move both balances**, then **write the linked pair** — `transfer_out` on the sender, `transfer_in` on the receiver — sharing one `transferId`, each with its own unbroken chain. All inside one `$transaction`: both rows land or neither does.
5. **Return the sender's row only.** The receiver's balance never leaves the system.

**Interview-ready principles (new in 4b):**
- **Deadlock is a lock-*ordering* problem, not a locking problem** — take multiple locks in a fixed, data-independent order (sort the ids) and cycles cannot form.
- **Detection vs prevention** — Postgres will *detect* a deadlock and kill a victim (`40P01`), but a correct lock order *prevents* it ever happening.
- **Independent invariants, independent codes** — the same physical race yields `400` (never-negative) here and `409` (settle-once) in M4a, because different invariants are guarding.
- **Double-entry keeps every chain honest** — one row per wallet, linked by a shared id; no single row can record two wallets' histories.
- **Authorization asymmetry mirrors the real world** — own your source, only reach the destination; ownership is a capability, so no new permission.
- **Response privacy is a first-class concern** — control what leaves, not only what's stored.

**Deferred (noted, not built):** FX conversion (M4c); reversals/disputes; recipient lookup by email; transfer limits / velocity / fraud rules; threshold-based approval; the integration-test harness against a real test DB (so lock ordering is covered by `npm test`, not just the curl proofs); pagination on wallet history; KYC gating (optional, unscheduled).
