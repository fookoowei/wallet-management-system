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
