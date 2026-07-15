# Milestone 2 — Authentication (detailed plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans — implement task-by-task,
> each task ends green. Steps use checkbox (`- [ ]`) syntax. This document extends the roadmap in
> `2026-07-13-wallet-management-system.md` (see its Milestone Roadmap table, row 2).

**Milestone deliverable:** A working authentication system on the NestJS API:
- `POST /auth/register` — public self-registration; creates a default `user`-role account (bcrypt-hashed password).
- `POST /auth/login` — verifies credentials, returns an **access token** + a **refresh token**.
- `POST /auth/refresh` — trades a valid refresh token for a fresh access+refresh pair (**rotation**).
- `POST /auth/logout` — revokes the presented refresh token.
- `GET /auth/me` — a protected route returning the current user, guarded by `JwtAuthGuard`.
- All logic-bearing code built red→green with Jest.

## Design decisions (chosen with the user, 2026-07-15)

1. **Registration model: public self-register.** Anyone can `POST /auth/register` and gets the `user`
   role. Staff/admin accounts are created by the seed (or by admins once RBAC lands in M3).
2. **Two-token model.**
   - **Access token — stateless JWT.** Signed with `JWT_ACCESS_SECRET`, ~15 min expiry. Payload:
     `{ sub: userId, email, role: <roleName> }`. Verified by signature alone (no DB lookup) → fast.
   - **Refresh token — stateful opaque string.** A high-entropy random string (NOT a JWT). It carries
     no claims; its authority lives entirely in a DB row. We store only its **SHA-256 hash**, never the
     raw value. ~7-day expiry held on the row.
3. **Rotation + revocation.** On every `/auth/refresh`, the old refresh row is **deleted** and a new one
   issued (rotation). `/auth/logout` deletes the row. An unknown/expired refresh token → `401`.
   *(Enhancement noted for later: token "families" for stolen-token reuse detection — out of scope for M2.)*
4. **Hashing choices — and why they differ:**
   - **Passwords → bcrypt** (slow, salted). Passwords are low-entropy and human-chosen, so we need
     deliberate slowness to resist brute force. We can't look a password up, so a per-row salt is fine.
   - **Refresh tokens → SHA-256** (fast, unsalted). The token is already 256+ bits of randomness, so
     brute force is a non-issue; we need a **deterministic** hash so we can look the row up by hash.
   This contrast is a deliberate teaching point.

## Why store the refresh token hashed?

Same reasoning as passwords: if the DB leaks, the attacker gets hashes, not usable tokens. A SHA-256
hash can't be reversed to the original random string, so stored rows are useless to a thief — yet we can
still verify an incoming token by hashing it and comparing.

## File structure created in this milestone

```
backend/
├── prisma/
│   └── schema.prisma                 # + RefreshToken model, User.refreshTokens back-relation
└── src/
    ├── main.ts                       # + global ValidationPipe
    ├── app.module.ts                 # + AuthModule
    └── auth/
        ├── auth.module.ts            # wires JwtModule, controller, services, strategy
        ├── auth.controller.ts        # register / login / refresh / logout / me routes
        ├── auth.service.ts           # register + login + credential verification
        ├── auth.service.spec.ts      # unit tests (bcrypt paths)
        ├── tokens.service.ts         # issue access JWT, issue/rotate/revoke refresh tokens
        ├── tokens.service.spec.ts    # unit tests (rotation happy + reuse paths)
        ├── dto/
        │   ├── register.dto.ts       # class-validator rules
        │   └── login.dto.ts
        ├── strategies/
        │   └── jwt.strategy.ts       # passport-jwt: validates access tokens
        ├── guards/
        │   └── jwt-auth.guard.ts     # AuthGuard('jwt')
        └── decorators/
            └── current-user.decorator.ts  # pulls req.user into a param
```

> **Note on architecture:** For M2, `AuthService`/`TokensService` talk to `PrismaService` directly
> (it's a global provider). We deliberately do *not* introduce a `UsersService` yet — fewer moving
> parts while auth concepts land. Extracting a `UsersModule` is a planned M3 refactor (a good lesson
> in refactoring under test coverage).

> **Note on TDD granularity:** We unit-test the **logic-bearing** code — password verification,
> registration rules, and refresh-token rotation. We do *not* write unit tests for thin Prisma
> wrappers or the controller (mocking Prisma just to assert we called Prisma tests the mock, not us);
> those are covered by the end-to-end `curl` verification at the end of each task.

---

### Task 1: Add the `RefreshToken` table (schema + migration)

**Files:** Modify `backend/prisma/schema.prisma`. Generates a new migration folder.

**Interfaces:** Produces table `RefreshToken` and the typed `prisma.refreshToken` client.

- [ ] **Step 1: Add the model + back-relation.** In `backend/prisma/schema.prisma`, add a
  `refreshTokens RefreshToken[]` field to `model User`, and add:

```prisma
model RefreshToken {
  id        String   @id @default(uuid())
  tokenHash String   @unique            // SHA-256 hex of the raw refresh token
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId    String
  expiresAt DateTime
  createdAt DateTime @default(now())

  @@index([userId])
}
```

`onDelete: Cascade` means deleting a user auto-deletes their tokens. `@unique` on `tokenHash` lets us
look a token up by its hash.

- [ ] **Step 2: Create the migration.** With Postgres up (`docker compose ps`):

```bash
cd backend
npm run prisma:migrate -- --name add_refresh_tokens
```

Expected: `Your database is now in sync with your schema` + a new `migrations/<ts>_add_refresh_tokens/`.

- [ ] **Step 3: Verify the table exists.**

```bash
docker exec -it wallet_db psql -U wallet -d wallet_db -c "\dt"
```

Expected: `RefreshToken` now listed alongside `User`, `Role`, `Permission`, etc.

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "feat: add RefreshToken model and migration (Milestone 2, Task 1)"
```

---

### Task 2: Auth dependencies + module skeleton + global validation

**Files:** Create `backend/src/auth/auth.module.ts`; modify `backend/src/app.module.ts`,
`backend/src/main.ts`, `backend/package.json`.

**Interfaces:** Produces a wired (empty) `AuthModule` with `JwtModule` configured from env, and a
global `ValidationPipe`. Consumes `JWT_ACCESS_SECRET`.

- [ ] **Step 1: Install dependencies.**

```bash
cd backend
npm install @nestjs/jwt @nestjs/passport passport passport-jwt class-validator class-transformer
npm install --save-dev @types/passport-jwt
```

- What each is: `@nestjs/jwt` (sign/verify access JWTs), `@nestjs/passport` + `passport` +
  `passport-jwt` (the strategy/guard machinery that reads `Authorization: Bearer` headers),
  `class-validator` + `class-transformer` (declarative DTO validation). `bcrypt` is already installed.

- [ ] **Step 2: Turn on global validation.** In `backend/src/main.ts`, before `app.listen(...)`:

```typescript
import { ValidationPipe } from '@nestjs/common';
// ...
app.useGlobalPipes(
  new ValidationPipe({ whitelist: true, transform: true }),
);
```

`whitelist: true` strips unknown properties; `transform: true` coerces payloads into DTO class
instances so validation decorators run.

- [ ] **Step 3: Create the AuthModule skeleton** at `backend/src/auth/auth.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [],
  providers: [],
})
export class AuthModule {}
```

`registerAsync` + `useFactory` lets the JWT secret come from `ConfigService` at runtime (not hard-coded).

- [ ] **Step 4: Register AuthModule** in `backend/src/app.module.ts` (add `AuthModule` to `imports`).

- [ ] **Step 5: Verify the app still boots.**

```bash
cd backend && npm run start:dev
```

Expected: starts cleanly, no DI errors. Ctrl-C to stop.

- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "feat: scaffold AuthModule with JWT config and global validation (Milestone 2, Task 2)"
```

---

### Task 3: Registration (`POST /auth/register`) — TDD

**Files:** Create `auth/dto/register.dto.ts`, `auth/auth.service.ts`, `auth/auth.service.spec.ts`,
`auth/auth.controller.ts`; modify `auth/auth.module.ts`.

**Interfaces:**
- Produces `AuthService.register(dto): Promise<SafeUser>` (no `passwordHash` in the return).
- Produces `POST /auth/register` → `201` with the created user (minus hash).

- [ ] **Step 1: Write the DTO** at `auth/dto/register.dto.ts`:

```typescript
import { IsEmail, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @MinLength(1)
  firstName: string;

  @IsString()
  @MinLength(1)
  lastName: string;
}
```

- [ ] **Step 2: Write the failing tests** at `auth/auth.service.spec.ts`. Cover: (a) a successful
  register hashes the password (stored hash ≠ plaintext) and returns a user without `passwordHash`;
  (b) registering an existing email throws `ConflictException`. Mock `PrismaService` with
  `user.findUnique`, `user.create`, and `role.findUnique` (returns the `user` role). Run and confirm
  it fails (`Cannot find module './auth.service'`).

```bash
cd backend && npm test -- auth.service
```

- [ ] **Step 3: Implement `AuthService.register`** at `auth/auth.service.ts`:

```typescript
import { ConflictException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');

    const role = await this.prisma.role.findUniqueOrThrow({ where: { name: 'user' } });
    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        roleId: role.id,
      },
    });

    const { passwordHash: _omit, ...safe } = user;
    return safe;
  }
}
```

- [ ] **Step 4: Make the tests pass.** `npm test -- auth.service` → green.

- [ ] **Step 5: Add the controller** at `auth/auth.controller.ts` with `@Post('register')`, and wire
  `AuthController` + `AuthService` into `auth.module.ts` (`controllers`, `providers`).

- [ ] **Step 6: Verify end-to-end.** Start the server, then:

```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"Password123","firstName":"Alice","lastName":"Lee"}'
```

Expected: `201`, JSON user with `id`, `email`, `role`-ish fields, and **no** `passwordHash`. Re-running
the same command → `409 Conflict`. A bad body (e.g. short password) → `400` from the ValidationPipe.

- [ ] **Step 7: Commit.**

```bash
git add -A && git commit -m "feat: add POST /auth/register with bcrypt hashing, via TDD (Milestone 2, Task 3)"
```

---

### Task 4: Login + token issuance (`POST /auth/login`) — TDD

**Files:** Create `auth/dto/login.dto.ts`, `auth/tokens.service.ts`, `auth/tokens.service.spec.ts`;
modify `auth/auth.service.ts` (+`login`), `auth/auth.service.spec.ts`, `auth/auth.controller.ts`,
`auth/auth.module.ts`.

**Interfaces:**
- `TokensService.issueTokens(user): Promise<{ accessToken, refreshToken }>` — signs the access JWT and
  creates+stores a hashed refresh token row.
- `AuthService.login(dto): Promise<{ accessToken, refreshToken }>` — verifies credentials, delegates
  to `TokensService`. Wrong email or password → `UnauthorizedException` (same message for both, so we
  don't leak which field was wrong).
- `POST /auth/login` returning both tokens.

- [ ] **Step 1: Login DTO** (`email`, `password` — `@IsEmail`, `@IsString`).

- [ ] **Step 2: Write `TokensService`** at `auth/tokens.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const REFRESH_TTL_DAYS = 7;

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issueTokens(user: { id: string; email: string; role: { name: string } }) {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role.name,
    });

    const refreshToken = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.refreshToken.create({
      data: { tokenHash: this.hash(refreshToken), userId: user.id, expiresAt },
    });

    return { accessToken, refreshToken };
  }
}
```

- [ ] **Step 3: `tokens.service.spec.ts`** — with a mocked `JwtService`
  (`signAsync: jest.fn().mockResolvedValue('signed.jwt')`) and mocked `PrismaService`
  (`refreshToken.create: jest.fn()`), assert `issueTokens` returns an `accessToken` equal to the
  signed value and a non-empty `refreshToken`, and that `refreshToken.create` was called with a
  `tokenHash` that is **not** equal to the returned raw token (proves we store the hash, not the token).

- [ ] **Step 4: Add `AuthService.login`** — look up user by email (include `role`), `bcrypt.compare`
  the password, throw `UnauthorizedException('Invalid credentials')` on any failure, else
  `return this.tokens.issueTokens(user)`. Inject `TokensService` into `AuthService`. Add spec cases:
  wrong password → throws; correct → returns tokens (mock `bcrypt.compare` / `TokensService`).

- [ ] **Step 5: Green.** `npm test -- auth.service tokens.service` → all pass.

- [ ] **Step 6: Controller + module.** Add `@Post('login')`; register `TokensService` in
  `auth.module.ts` providers.

- [ ] **Step 7: Verify end-to-end.**

```bash
curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"Password123"}'
```

Expected: `201` with `{ "accessToken": "...", "refreshToken": "..." }`. Wrong password → `401`.
Confirm a row landed: `docker exec -it wallet_db psql -U wallet -d wallet_db -c 'SELECT "userId", "expiresAt" FROM "RefreshToken";'`

- [ ] **Step 8: Commit.**

```bash
git add -A && git commit -m "feat: add POST /auth/login issuing access + stored refresh tokens, via TDD (Milestone 2, Task 4)"
```

---

### Task 5: JWT strategy + guard + protected `GET /auth/me`

**Files:** Create `auth/strategies/jwt.strategy.ts`, `auth/guards/jwt-auth.guard.ts`,
`auth/decorators/current-user.decorator.ts`; modify `auth/auth.controller.ts`, `auth/auth.module.ts`.

**Interfaces:**
- `JwtStrategy` validates the access token's signature/expiry and returns the payload as `req.user`.
- `JwtAuthGuard` = `AuthGuard('jwt')`, applied per-route with `@UseGuards`.
- `@CurrentUser()` param decorator exposes `req.user`.
- `GET /auth/me` → the current user's claims (guarded).

- [ ] **Step 1: The strategy** at `auth/strategies/jwt.strategy.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET'),
    });
  }

  // Return value becomes req.user. Passport already verified signature + expiry.
  async validate(payload: { sub: string; email: string; role: string }) {
    return { userId: payload.sub, email: payload.email, role: payload.role };
  }
}
```

- [ ] **Step 2: The guard** at `auth/guards/jwt-auth.guard.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

- [ ] **Step 3: The decorator** at `auth/decorators/current-user.decorator.ts`:

```typescript
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user,
);
```

- [ ] **Step 4: Register the strategy** in `auth.module.ts` providers (`JwtStrategy`).

- [ ] **Step 5: Add the protected route** in `auth.controller.ts`:

```typescript
@UseGuards(JwtAuthGuard)
@Get('me')
me(@CurrentUser() user: { userId: string; email: string; role: string }) {
  return user;
}
```

- [ ] **Step 6: Verify end-to-end.** Log in, capture the access token, then:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"Password123"}' | npx --yes json accessToken)
curl -s http://localhost:3000/auth/me                              # → 401 Unauthorized
curl -s http://localhost:3000/auth/me -H "Authorization: Bearer $TOKEN"   # → { userId, email, role }
```

*(If `json` is unavailable, copy the token from the login response by hand.)* Expected: no header → `401`;
valid Bearer token → the user's claims.

- [ ] **Step 7: Commit.**

```bash
git add -A && git commit -m "feat: add JWT strategy, guard, and protected GET /auth/me (Milestone 2, Task 5)"
```

---

### Task 6: Refresh rotation + logout — TDD

**Files:** Modify `auth/tokens.service.ts` (+`rotate`, `revoke`), `auth/tokens.service.spec.ts`,
`auth/auth.controller.ts` (+`refresh`, `logout`), add a `RefreshDto`.

**Interfaces:**
- `TokensService.rotate(rawRefreshToken): Promise<{ accessToken, refreshToken }>` — verify the token
  by hash lookup, ensure not expired, **delete** the old row, issue a fresh pair. Unknown/expired → `UnauthorizedException`.
- `TokensService.revoke(rawRefreshToken): Promise<void>` — delete the row (idempotent).
- `POST /auth/refresh` and `POST /auth/logout` (both take `{ refreshToken }`).

- [ ] **Step 1: Write the failing rotation tests** in `tokens.service.spec.ts`:
  - happy path: given a stored (non-expired) token, `rotate` deletes the old row, creates a new one,
    and returns new tokens.
  - reuse/unknown: a token whose hash isn't found → throws `UnauthorizedException`.
  - expired: a found-but-`expiresAt < now` row → throws (and is deleted).
  Mock `prisma.refreshToken.findUnique`/`delete`/`create`, `prisma.user.findUnique` (returns the user
  with `role`), and `jwt.signAsync`.

- [ ] **Step 2: Implement `rotate` + `revoke`** in `TokensService`:

```typescript
async rotate(rawRefreshToken: string) {
  const tokenHash = this.hash(rawRefreshToken);
  const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored) throw new UnauthorizedException('Invalid refresh token');

  await this.prisma.refreshToken.delete({ where: { id: stored.id } }); // rotation: old dies now
  if (stored.expiresAt < new Date()) throw new UnauthorizedException('Refresh token expired');

  const user = await this.prisma.user.findUniqueOrThrow({
    where: { id: stored.userId },
    include: { role: true },
  });
  return this.issueTokens(user);
}

async revoke(rawRefreshToken: string): Promise<void> {
  await this.prisma.refreshToken.deleteMany({ where: { tokenHash: this.hash(rawRefreshToken) } });
}
```

- [ ] **Step 3: Green.** `npm test -- tokens.service` → all pass.

- [ ] **Step 4: Controllers.** `@Post('refresh')` → `tokens.rotate(dto.refreshToken)`;
  `@Post('logout')` → `tokens.revoke(dto.refreshToken)` returning `{ success: true }`.

- [ ] **Step 5: Verify the full flow end-to-end.**

```bash
# login → grab refreshToken; refresh → get a new pair; old refresh now rejected; logout revokes.
curl -s -X POST http://localhost:3000/auth/refresh -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<paste>"}'            # → new { accessToken, refreshToken }
# reuse the OLD refreshToken again → 401 (it was rotated away)
curl -s -X POST http://localhost:3000/auth/logout  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<the new one>"}'      # → { success: true }; using it again → 401
```

- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "feat: add refresh-token rotation and logout, via TDD (Milestone 2, Task 6)"
```

---

### Task 7: Milestone review + learning notes

- [ ] **Step 1: Full test run + typecheck.** `cd backend && npm test && npx tsc --noEmit` → all green, 0 errors.
- [ ] **Step 2: Append to `docs/learning-notes.md`** (simple, non-overwhelming): JWT anatomy
  (header.payload.signature); access vs refresh (**stateless vs stateful**); why we hash refresh
  tokens and why SHA-256 here vs bcrypt for passwords; what a Passport **strategy** and a **guard**
  are; DTOs + `ValidationPipe`; token **rotation** and revocation.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "docs: add auth concepts to learning notes (Milestone 2)"`

## Milestone 2 self-review checklist

- [ ] Register → login → access `GET /auth/me` → refresh → old refresh rejected → logout all work via `curl`.
- [ ] `npm test` green; passwords stored as bcrypt hashes; refresh tokens stored as SHA-256 hashes (never raw).
- [ ] `GET /auth/me` returns `401` without a token, the user with one.
- [ ] **You can explain:** what's inside a JWT and how the signature prevents forgery; why there are two
      tokens; the difference between the stateless access token and the stateful refresh token; what
      rotation buys us; and why passwords use bcrypt but refresh tokens use SHA-256.

## What Milestone 3 will cover (preview)

RBAC enforcement: a `@Permissions('withdrawal.approve')` decorator + a `PermissionsGuard` that reads the
user's role→permissions and gates endpoints; likely the `UsersService` extraction; separation-of-duties
checks. Detailed plan written when we reach it.
