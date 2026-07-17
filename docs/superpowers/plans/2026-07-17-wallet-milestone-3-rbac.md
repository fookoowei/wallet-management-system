# Milestone 3 — RBAC (detailed plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans — implement task-by-task,
> each task ends green. Steps use checkbox (`- [ ]`) syntax. This document extends the roadmap in
> `2026-07-13-wallet-management-system.md` (see its Milestone Roadmap table, row 3) and implements
> the design in `../specs/2026-07-17-wallet-milestone-3-rbac-design.md`.

**Goal:** Gate routes by permission. The `Role ↔ Permission` data seeded in M1 finally gets read and
enforced, and a user's access can be revoked immediately.

**Architecture:** A `@RequirePermissions('user.manage')` decorator tags routes with metadata. A
`PermissionsGuard` reads that metadata via `Reflector`, loads the caller from the DB
(`user → role → permissions`) using the id `JwtAuthGuard` already put on the request, and allows or
throws `403`. Permissions are **read from the database on every guarded request, never from the
token** — a signed JWT cannot be un-issued, so a token-borne permission list would keep a suspended
user authorised until it expired. A new `UsersModule` (`UsersService` + `RolesService`) becomes the
only owner of user/role data access, extracted out of `AuthService`.

**Tech Stack:** NestJS 11, Prisma 6 (`prisma-client-js`), PostgreSQL 16, Jest, class-validator +
class-transformer.

## Global Constraints

- **No schema changes, no migration, no `prisma:generate`.** M3 is pure application logic.
- Money/roles/permissions are **seed data** — no roles CRUD (spec §3).
- Every logic-bearing change is **TDD red→green**. Framework plumbing is not unit-tested.
- Never return `passwordHash` in any response.
- `401` = identity unknown (`JwtAuthGuard`). `403` = identity known, action refused (`PermissionsGuard`).
- Guard order is always `@UseGuards(JwtAuthGuard, PermissionsGuard)` — authentication before authorization.
- Existing file layout is **flat inside module folders** (`auth/jwt.strategy.ts`, not `auth/strategies/…`). Match it.
- `PrismaModule` is `@Global()` — modules do **not** import it to get `PrismaService`.
- Any type used in a **decorated signature** must use `import type` (TS1272 — this bit us in M2).
- `npx tsc --noEmit` and `npm test` (run from `backend/`) are the source of truth, **not** editor squiggles.
- One conventional commit per task. The user pushes.

---

## File structure created in this milestone

```
backend/src/
├── auth/
│   ├── auth.service.ts                 # MODIFIED: talks to UsersService/RolesService, not Prisma
│   ├── auth.service.spec.ts            # MODIFIED: mock wiring only — assertions unchanged
│   ├── auth.module.ts                  # MODIFIED: imports UsersModule
│   ├── require-permissions.decorator.ts  # NEW: @RequirePermissions(...codes)
│   ├── permissions.guard.ts            # NEW: the enforcer
│   └── permissions.guard.spec.ts       # NEW: full TDD
└── users/
    ├── users.module.ts                 # NEW: provides+exports UsersService, RolesService
    ├── users.service.ts                # NEW: sole owner of prisma.user
    ├── users.service.spec.ts           # NEW
    ├── users.controller.ts             # NEW: /users routes
    ├── roles.service.ts                # NEW: read-only role queries
    ├── roles.controller.ts             # NEW: GET /roles
    ├── to-safe-user.ts                 # NEW: pure fn, strips passwordHash
    └── dto/
        ├── list-users-query.dto.ts     # NEW
        ├── update-user-status.dto.ts   # NEW
        └── update-user-role.dto.ts     # NEW
```

---

## Task 1: Extract `UsersService` + `RolesService`; rewire `AuthService`

**A pure refactor: zero behaviour change.** The existing tests are the safety net.

> **The rule for this task (spec §7):** *assertions* must not change — they describe behaviour, and a
> refactor changes none. *Mock wiring* in `auth.service.spec.ts` **must** change, from a
> `PrismaService` mock to `UsersService`/`RolesService` mocks, because `AuthService`'s collaborators
> changed. That is expected and is itself the lesson: mock-based unit tests are coupled to *who a
> class talks to*. Editing a wiring line is routine; **editing an assertion means behaviour drifted —
> stop and investigate.**

**Files:**
- Create: `backend/src/users/to-safe-user.ts`, `backend/src/users/users.service.ts`,
  `backend/src/users/roles.service.ts`, `backend/src/users/users.module.ts`
- Modify: `backend/src/auth/auth.service.ts`, `backend/src/auth/auth.module.ts`,
  `backend/src/auth/auth.service.spec.ts`
- Untouched: `backend/src/auth/tokens.service.ts` — it owns the `RefreshToken` table, which is not a
  user table. Only *user-row* access moves.

**Interfaces produced (later tasks rely on these exact names):**
- `toSafeUser<T extends { passwordHash: string }>(user: T): Omit<T, 'passwordHash'>`
- `UsersService.create(data: CreateUserData): Promise<User>`
- `UsersService.findByEmail(email: string)`
- `UsersService.findByEmailWithRole(email: string)`
- `UsersService.findByIdWithPermissions(id: string)`
- `RolesService.findByName(name: string)`, `RolesService.findByNameOrThrow(name: string)`, `RolesService.findAll()`

- [ ] **Step 1: Record the baseline.** Everything must be green *before* a refactor, or you won't know
      what you broke.

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; 4 suites, 13 tests passing.

- [ ] **Step 2: The pure helper** at `backend/src/users/to-safe-user.ts`:

```typescript
/**
 * Strip the password hash before a user row ever leaves the API.
 *
 * A plain function, not a service method: it has no dependencies, so DI would be
 * ceremony — and a method on a mocked UsersService would make "register returns no
 * password hash" a vacuous assertion. As an import it stays real in every test.
 */
export function toSafeUser<T extends { passwordHash: string }>(user: T): Omit<T, 'passwordHash'> {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}
```

- [ ] **Step 3: `UsersService`** at `backend/src/users/users.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateUserData {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  roleId: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateUserData) {
    return this.prisma.user.create({ data });
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByEmailWithRole(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      include: { role: true },
    });
  }

  /**
   * The guard's lookup: the whole authorisation picture in one query.
   * Returns the RAW row (hash included) — only PermissionsGuard consumes it and its
   * result never reaches a response, so it is deliberately not passed through toSafeUser.
   */
  findByIdWithPermissions(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: { role: { include: { permissions: true } } },
    });
  }
}
```

- [ ] **Step 4: `RolesService`** at `backend/src/users/roles.service.ts`. `Role` is its own entity, so
      role queries do not belong in `UsersService`. Read-only — roles are seed data:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  findByName(name: string) {
    return this.prisma.role.findUnique({ where: { name } });
  }

  /** Throws if absent. Used where a missing role means the seed is broken, not bad input. */
  findByNameOrThrow(name: string) {
    return this.prisma.role.findUniqueOrThrow({ where: { name } });
  }

  findAll() {
    return this.prisma.role.findMany({
      select: { id: true, name: true, description: true },
      orderBy: { name: 'asc' },
    });
  }
}
```

- [ ] **Step 5: `UsersModule`** at `backend/src/users/users.module.ts`. No `imports` — `PrismaModule`
      is `@Global()`, so `PrismaService` is already injectable anywhere:

```typescript
import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { RolesService } from './roles.service';

@Module({
  providers: [UsersService, RolesService],
  exports: [UsersService, RolesService],
})
export class UsersModule {}
```

- [ ] **Step 6: Rewire `AuthService`** at `backend/src/auth/auth.service.ts`. Note what leaves and what
      stays: the *queries* move out; the hashing, the anti-enumeration timing, and the token
      orchestration stay — that is what auth is actually about. **Full file:**

```typescript
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { RolesService } from '../users/roles.service';
import { toSafeUser } from '../users/to-safe-user';
import { TokensService } from './tokens.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

// Precomputed once at startup. When an email doesn't exist we still run one
// bcrypt.compare against this dummy hash, so login takes ~constant time and
// can't be used as a timing oracle to discover which emails have accounts.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('a-non-matching-dummy-password', 10);

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly tokens: TokensService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) throw new ConflictException('Email already registered');

    const role = await this.roles.findByNameOrThrow('user');
    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.users.create({
      email: dto.email,
      passwordHash,
      firstName: dto.firstName,
      lastName: dto.lastName,
      roleId: role.id,
    });

    return toSafeUser(user);
  }

  async login(dto: LoginDto) {
    const user = await this.users.findByEmailWithRole(dto.email);

    // Same vague failure for "no such email" AND "wrong password" — this denies
    // an attacker any signal about which emails have accounts (user enumeration).
    // Always run one bcrypt.compare (dummy hash if no user) to keep timing constant.
    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !passwordMatches) throw new UnauthorizedException('Invalid credentials');

    return this.tokens.issueTokens(user);
  }
}
```

- [ ] **Step 7: Wire the module.** In `backend/src/auth/auth.module.ts`, add the import of
      `UsersModule` from `'../users/users.module'`, and add `UsersModule` as the **first entry** of the
      `imports` array (before `PassportModule`). Providers stay exactly as they are.

- [ ] **Step 8: Rewire the test mocks** in `backend/src/auth/auth.service.spec.ts`. Replace the
      `PrismaService` import with `UsersService` and `RolesService` imports (from `'../users/…'`), and
      replace `buildService` with:

```typescript
// Build a fresh AuthService wired to mocked collaborators for each test.
// AuthService no longer knows Prisma exists — it talks to UsersService/RolesService.
function buildService(
  usersMock: any,
  rolesMock: any = {
    findByNameOrThrow: jest.fn().mockResolvedValue({ id: 'role-1', name: 'user' }),
  },
  tokensMock: any = { issueTokens: jest.fn() },
) {
  return Test.createTestingModule({
    providers: [
      AuthService,
      { provide: UsersService, useValue: usersMock },
      { provide: RolesService, useValue: rolesMock },
      { provide: TokensService, useValue: tokensMock },
    ],
  })
    .compile()
    .then((moduleRef) => moduleRef.get(AuthService));
}
```

Then update each test's mock object from the Prisma shape to the service shape. The two mappings:
- `prismaMock.user.findUnique` → `usersMock.findByEmail` (register) or `usersMock.findByEmailWithRole` (login)
- `prismaMock.user.create` → `usersMock.create`, and its callback arg changes from `({ data })` to `(data)` — `UsersService.create(data)` takes the data object directly, not Prisma's `{ data }` wrapper.

So the register happy-path mock becomes:

```typescript
const usersMock = {
  findByEmail: jest.fn().mockResolvedValue(null), // email not taken
  create: jest.fn().mockImplementation((data) =>
    Promise.resolve({
      id: 'user-1',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }),
  ),
};
```

**Change nothing below the mock objects.** Every `expect(...)` stays byte-for-byte identical.

- [ ] **Step 9: Green — and prove the refactor was faithful.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; **the same 4 suites / 13 tests passing as in Step 1.** A changed count means
you added or lost behaviour — investigate, don't paper over it.

- [ ] **Step 10: Prove it end-to-end** (the tests all use mocks; this is the only step that touches a
      real database). With Postgres up (`docker compose ps`) and `npm run start:dev` running:

```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"refactor-check@example.com","password":"Password123","firstName":"Ref","lastName":"Actor"}'
```
Expected: `201`, a JSON user with `id`/`email`/`roleId`, and **no `passwordHash` field**.

```bash
curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"refactor-check@example.com","password":"Password123"}'
```
Expected: `200` with `accessToken` + `refreshToken`.

- [ ] **Step 11: Commit.**

```bash
git add backend/src/users backend/src/auth
git commit -m "refactor: extract UsersService and RolesService from AuthService (Milestone 3, Task 1)"
```

---

## Task 2: `@RequirePermissions` + `PermissionsGuard` — TDD

**This one gets full TDD, and it's worth knowing why.** In M2 we deliberately did *not* unit-test
`JwtAuthGuard` or `JwtStrategy`: they are thin wrappers over Passport containing no logic of ours, so
testing them would have tested Passport. `PermissionsGuard` is the opposite — our code, our branching,
and the only thing standing between a support agent and your withdrawal approvals.

**Files:**
- Create: `backend/src/auth/require-permissions.decorator.ts`, `backend/src/auth/permissions.guard.ts`,
  `backend/src/auth/permissions.guard.spec.ts`

**Interfaces:**
- Consumes: `UsersService.findByIdWithPermissions` (Task 1), `AuthUser` from `auth/jwt.strategy` (M2)
- Produces: `RequirePermissions(...codes: string[])`, `PERMISSIONS_KEY`, `PermissionsGuard`

- [ ] **Step 1: The decorator** at `backend/src/auth/require-permissions.decorator.ts`. It performs no
      logic — it pins a label to the route for a guard to read later. Counterpart to `@CurrentUser`
      from M2: same mechanism family, opposite direction (that one *reads* from the request at call
      time; this one *writes* onto the route at definition time):

```typescript
import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Tag a route (or a whole controller) with the permission codes its caller must hold.
 * All listed codes are required (AND). Enforcement lives in PermissionsGuard.
 */
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);
```

- [ ] **Step 2: Write the failing tests** at `backend/src/auth/permissions.guard.spec.ts`. Note we build
      the guard with plain `new` rather than `Test.createTestingModule` — it's an ordinary class, and DI
      buys us nothing here:

```typescript
import { ForbiddenException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import type { AuthUser } from './jwt.strategy';

// A user row as findByIdWithPermissions returns it: role joined, permissions joined.
const userRow = (codes: string[], status = 'active') => ({
  id: 'user-1',
  status,
  role: { name: 'admin', permissions: codes.map((code) => ({ code })) },
});

// The minimum ExecutionContext the guard actually touches.
function buildContext(user?: Partial<AuthUser>): ExecutionContext {
  return {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function buildGuard(required: string[] | undefined, usersMock: any) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(required),
  } as unknown as Reflector;
  return new PermissionsGuard(reflector, usersMock);
}

describe('PermissionsGuard', () => {
  it('allows a route that requires no permissions, without touching the DB', async () => {
    const users = { findByIdWithPermissions: jest.fn() };
    const guard = buildGuard(undefined, users);

    await expect(guard.canActivate(buildContext({ id: 'user-1' }))).resolves.toBe(true);
    expect(users.findByIdWithPermissions).not.toHaveBeenCalled();
  });

  it('allows when the caller holds every required permission', async () => {
    const users = {
      findByIdWithPermissions: jest.fn().mockResolvedValue(userRow(['user.manage', 'audit.view'])),
    };
    const guard = buildGuard(['user.manage'], users);

    await expect(guard.canActivate(buildContext({ id: 'user-1' }))).resolves.toBe(true);
  });

  it('denies when one of several required permissions is missing', async () => {
    const users = {
      findByIdWithPermissions: jest.fn().mockResolvedValue(userRow(['user.manage'])),
    };
    const guard = buildGuard(['user.manage', 'audit.view'], users);

    await expect(guard.canActivate(buildContext({ id: 'user-1' }))).rejects.toThrow(ForbiddenException);
  });

  it('denies a suspended user even when the role holds the permission', async () => {
    const users = {
      findByIdWithPermissions: jest.fn().mockResolvedValue(userRow(['user.manage'], 'suspended')),
    };
    const guard = buildGuard(['user.manage'], users);

    await expect(guard.canActivate(buildContext({ id: 'user-1' }))).rejects.toThrow('Account suspended');
  });

  it('denies when the user no longer exists in the database', async () => {
    const users = { findByIdWithPermissions: jest.fn().mockResolvedValue(null) };
    const guard = buildGuard(['user.manage'], users);

    await expect(guard.canActivate(buildContext({ id: 'ghost' }))).rejects.toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 3: Run them and watch them fail.**

```bash
cd backend && npm test -- permissions.guard
```
Expected: FAIL — `Cannot find module './permissions.guard'`.

- [ ] **Step 4: Implement the guard** at `backend/src/auth/permissions.guard.ts`:

```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UsersService } from '../users/users.service';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import type { AuthUser } from './jwt.strategy';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Handler metadata wins over controller metadata, so a route can be stricter
    // than the class-level default.
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // A route that never asked for a permission is not this guard's business.
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const identity: AuthUser | undefined = request.user;
    // No identity means JwtAuthGuard didn't run before us — a wiring mistake, not an
    // attack. Fail closed rather than assume.
    if (!identity) throw new ForbiddenException('Access denied');

    // Read authority from the DB, never from the token: a JWT minted before a
    // suspension or role change still carries the old authority and cannot be un-issued.
    const user = await this.users.findByIdWithPermissions(identity.id);
    if (!user) throw new ForbiddenException('Access denied');
    if (user.status !== 'active') throw new ForbiddenException('Account suspended');

    const held = new Set(user.role.permissions.map((permission) => permission.code));
    if (!required.every((code) => held.has(code))) {
      // Deliberately vague: the caller learns they may not act, not the shape of
      // the permission model.
      throw new ForbiddenException('Access denied');
    }

    return true;
  }
}
```

- [ ] **Step 5: Green.**

```bash
cd backend && npm test -- permissions.guard && npx tsc --noEmit
```
Expected: 5 tests passing; tsc silent.

- [ ] **Step 6: Commit.**

```bash
git add backend/src/auth/require-permissions.decorator.ts backend/src/auth/permissions.guard.ts backend/src/auth/permissions.guard.spec.ts
git commit -m "feat: add @RequirePermissions decorator and PermissionsGuard (Milestone 3, Task 2)"
```

---

## Task 3: Read routes — `GET /users`, `GET /users/:id`, `GET /roles`

**Files:**
- Create: `backend/src/users/dto/list-users-query.dto.ts`, `backend/src/users/users.controller.ts`,
  `backend/src/users/roles.controller.ts`, `backend/src/users/users.service.spec.ts`
- Modify: `backend/src/users/users.service.ts` (add `findMany`, `findById`),
  `backend/src/users/users.module.ts` (register controllers),
  `backend/src/app.module.ts` (register `UsersModule`)

**Interfaces:**
- Consumes: `toSafeUser`, `UsersService`, `RolesService.findAll` (Task 1); `RequirePermissions`,
  `PermissionsGuard` (Task 2); `JwtAuthGuard` (M2)
- Produces: `UsersService.findMany({ skip?, take? })`, `UsersService.findById(id)`

- [ ] **Step 1: Confirm `class-transformer` is installed** — the query DTO needs `@Type`, and
      `main.ts` already runs `ValidationPipe({ transform: true })`:

```bash
cd backend && npm ls class-transformer
```
Expected: a version line, not `(empty)`. If empty: `npm install class-transformer`.

- [ ] **Step 2: Write the failing tests** at `backend/src/users/users.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

function buildService(prismaMock: any) {
  return Test.createTestingModule({
    providers: [UsersService, { provide: PrismaService, useValue: prismaMock }],
  })
    .compile()
    .then((moduleRef) => moduleRef.get(UsersService));
}

const row = (id: string) => ({
  id,
  email: `${id}@example.com`,
  passwordHash: 'hashed-secret',
  firstName: 'Test',
  lastName: 'User',
  status: 'active',
  roleId: 'role-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  role: { id: 'role-1', name: 'user' },
});

describe('UsersService.findMany', () => {
  it('passes pagination through and returns a total alongside the page', async () => {
    const prismaMock = {
      user: {
        findMany: jest.fn().mockResolvedValue([row('user-1')]),
        count: jest.fn().mockResolvedValue(37),
      },
    };
    const service = await buildService(prismaMock);

    const result = await service.findMany({ skip: 10, take: 5 });

    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 }),
    );
    expect(result.total).toBe(37);
    expect(result.users).toHaveLength(1);
  });

  it('never leaks a password hash', async () => {
    const prismaMock = {
      user: {
        findMany: jest.fn().mockResolvedValue([row('user-1'), row('user-2')]),
        count: jest.fn().mockResolvedValue(2),
      },
    };
    const service = await buildService(prismaMock);

    const result = await service.findMany({});

    for (const user of result.users) {
      expect(user).not.toHaveProperty('passwordHash');
    }
  });
});

describe('UsersService.findById', () => {
  it('returns the user without the password hash', async () => {
    const prismaMock = { user: { findUnique: jest.fn().mockResolvedValue(row('user-1')) } };
    const service = await buildService(prismaMock);

    const result = await service.findById('user-1');

    expect(result.email).toBe('user-1@example.com');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('throws NotFoundException when the user does not exist', async () => {
    const prismaMock = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = await buildService(prismaMock);

    await expect(service.findById('ghost')).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 3: Run them and watch them fail.**

```bash
cd backend && npm test -- users.service
```
Expected: FAIL — `service.findMany is not a function`.

- [ ] **Step 4: Implement.** In `backend/src/users/users.service.ts`, add `NotFoundException` to the
      `@nestjs/common` import, add `import { toSafeUser } from './to-safe-user';`, and add these two
      methods:

```typescript
  /** One page of users, plus the total so a UI can render "showing 10–20 of 37". */
  async findMany({ skip = 0, take = 20 }: { skip?: number; take?: number }) {
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: { role: { select: { id: true, name: true } } },
      }),
      this.prisma.user.count(),
    ]);
    return { total, skip, take, users: users.map(toSafeUser) };
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { role: { select: { id: true, name: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return toSafeUser(user);
  }
```

- [ ] **Step 5: Green.**

```bash
cd backend && npm test -- users.service
```
Expected: 4 tests passing.

- [ ] **Step 6: The query DTO** at `backend/src/users/dto/list-users-query.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListUsersQueryDto {
  // Query strings always arrive as text ("10", not 10). @Type tells the global
  // ValidationPipe (transform: true) to convert before @IsInt judges it.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100) // hard cap: a caller must never be able to ask for the whole table
  take?: number = 20;
}
```

- [ ] **Step 7: The users controller** at `backend/src/users/users.controller.ts`. Guards and the
      permission are declared **at class level**, so every route below inherits them — a route can
      still override with its own `@RequirePermissions`, which is why the guard uses
      `getAllAndOverride`:

```typescript
import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { UsersService } from './users.service';
import { ListUsersQueryDto } from './dto/list-users-query.dto';

// Order matters: JwtAuthGuard establishes *who* is calling and puts them on the
// request; PermissionsGuard is meaningless until it has. Authentication, then
// authorization.
@Controller('users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('user.manage')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query() query: ListUsersQueryDto) {
    return this.users.findMany(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.findById(id);
  }
}
```

- [ ] **Step 8: The roles controller** at `backend/src/users/roles.controller.ts`. Read-only — roles are
      seed data (spec §3). It exists to populate M6's "change this user's role" dropdown:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { RolesService } from './roles.service';

@Controller('roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('user.manage')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list() {
    return this.roles.findAll();
  }
}
```

- [ ] **Step 9: Register the controllers.** In `backend/src/users/users.module.ts`, import both
      controllers and add `controllers: [UsersController, RolesController],` to the `@Module({...})`
      object.

- [ ] **Step 10: Register the module.** In `backend/src/app.module.ts`, add
      `import { UsersModule } from './users/users.module';` and add `UsersModule` to the `imports`
      array (after `PrismaModule`, before `HealthModule`).

> Note there is no circular dependency here, and it's worth seeing why: `UsersModule` imports the
> *guard classes* from `../auth/…` as ordinary file imports, but it does **not** import `AuthModule`.
> `PermissionsGuard` needs `UsersService`, which `UsersModule` already provides. `AuthModule` imports
> `UsersModule` and not the reverse. One direction only.

- [ ] **Step 11: Verify end-to-end** — this is where RBAC first visibly works. Server running,
      Postgres up:

```bash
# 1. The seeded super-admin holds user.manage.
ADMIN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@wallet.local","password":"ChangeMe123!"}' | jq -r .accessToken)

curl -s -w '\n%{http_code}\n' http://localhost:3000/users -H "Authorization: Bearer $ADMIN"
```
Expected: `200` with `{ total, skip, take, users: [...] }`, no `passwordHash` anywhere.

```bash
# 2. A self-registered account has the `user` role, which seeds with ZERO permissions.
CUSTOMER=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"refactor-check@example.com","password":"Password123"}' | jq -r .accessToken)

curl -s -w '\n%{http_code}\n' http://localhost:3000/users -H "Authorization: Bearer $CUSTOMER"
```
Expected: **`403`** — authenticated fine, not permitted. This is the milestone working.

```bash
# 3. No token at all.
curl -s -w '\n%{http_code}\n' http://localhost:3000/users
```
Expected: **`401`** — identity unknown. Compare with the 403 above; that difference is the whole
401/403 distinction in one pair of commands.

```bash
# 4. Roles list.
curl -s http://localhost:3000/roles -H "Authorization: Bearer $ADMIN"
```
Expected: `200` with 5 roles, alphabetical.

- [ ] **Step 12: Commit.**

```bash
git add backend/src/users backend/src/app.module.ts
git commit -m "feat: add permission-gated GET /users, GET /users/:id, GET /roles (Milestone 3, Task 3)"
```

---

## Task 4: Write routes + separation-of-duties rules — TDD

**This is the milestone's substance.** The rules below are the reason this is RBAC rather than a
permission checkbox.

**Files:**
- Create: `backend/src/users/dto/update-user-status.dto.ts`, `backend/src/users/dto/update-user-role.dto.ts`
- Modify: `backend/src/users/users.service.ts` (inject `RolesService`; add `updateStatus`, `updateRole`),
  `backend/src/users/users.service.spec.ts` (rewire `buildService`; add tests),
  `backend/src/users/users.controller.ts` (two `@Patch` routes)

**Interfaces:**
- Consumes: `RolesService.findByName` (Task 1), `AuthUser` + `@CurrentUser` (M2)
- Produces: `UsersService.updateStatus(id, status, actor)`, `UsersService.updateRole(id, roleName, actor)`

- [ ] **Step 1: Rewire `buildService`** in `backend/src/users/users.service.spec.ts` — `UsersService`
      gains a second collaborator, so its test wiring changes (same lesson as Task 1). Add the
      `RolesService` import, then:

```typescript
function buildService(
  prismaMock: any,
  rolesMock: any = { findByName: jest.fn().mockResolvedValue({ id: 'role-2', name: 'finance' }) },
) {
  return Test.createTestingModule({
    providers: [
      UsersService,
      { provide: PrismaService, useValue: prismaMock },
      { provide: RolesService, useValue: rolesMock },
    ],
  })
    .compile()
    .then((moduleRef) => moduleRef.get(UsersService));
}
```

The four existing `users.service.spec.ts` tests keep passing untouched — they call `buildService`
with one argument and the default covers the rest.

- [ ] **Step 2: Write the failing tests.** Append to `backend/src/users/users.service.spec.ts`:

```typescript
const admin: AuthUser = { id: 'admin-1', email: 'admin@wallet.local', role: 'admin' };
const superAdmin: AuthUser = { id: 'sa-1', email: 'sa@wallet.local', role: 'super_admin' };

describe('UsersService.updateStatus', () => {
  it('suspends another user', async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue(row('user-1')),
        update: jest.fn().mockResolvedValue({ ...row('user-1'), status: 'suspended' }),
      },
    };
    const service = await buildService(prismaMock);

    const result = await service.updateStatus('user-1', 'suspended', admin);

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' }, data: { status: 'suspended' } }),
    );
    expect(result.status).toBe('suspended');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('refuses to let an actor suspend themselves', async () => {
    const prismaMock = { user: { findUnique: jest.fn(), update: jest.fn() } };
    const service = await buildService(prismaMock);

    await expect(service.updateStatus('admin-1', 'suspended', admin)).rejects.toThrow(ForbiddenException);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

describe('UsersService.updateRole', () => {
  it('changes another user\'s role', async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue(row('user-1')),
        update: jest.fn().mockResolvedValue({ ...row('user-1'), roleId: 'role-2' }),
      },
    };
    const service = await buildService(prismaMock);

    const result = await service.updateRole('user-1', 'finance', admin);

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' }, data: { roleId: 'role-2' } }),
    );
    expect(result).not.toHaveProperty('passwordHash');
  });

  // The rule that stops `user.manage` from being a back door to every permission.
  it('refuses to let an actor change their own role', async () => {
    const prismaMock = { user: { findUnique: jest.fn(), update: jest.fn() } };
    const service = await buildService(prismaMock);

    await expect(service.updateRole('admin-1', 'super_admin', admin)).rejects.toThrow(ForbiddenException);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  // Blocking self-promotion is pointless if an admin can crown an accomplice.
  it('refuses to let a non-super_admin assign the super_admin role', async () => {
    const prismaMock = { user: { findUnique: jest.fn(), update: jest.fn() } };
    const service = await buildService(prismaMock);

    await expect(service.updateRole('user-1', 'super_admin', admin)).rejects.toThrow(ForbiddenException);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('allows a super_admin to assign the super_admin role', async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue(row('user-1')),
        update: jest.fn().mockResolvedValue({ ...row('user-1'), roleId: 'role-9' }),
      },
    };
    const rolesMock = { findByName: jest.fn().mockResolvedValue({ id: 'role-9', name: 'super_admin' }) };
    const service = await buildService(prismaMock, rolesMock);

    await expect(service.updateRole('user-1', 'super_admin', superAdmin)).resolves.toBeDefined();
  });

  it('throws NotFoundException for an unknown role name', async () => {
    const prismaMock = { user: { findUnique: jest.fn(), update: jest.fn() } };
    const rolesMock = { findByName: jest.fn().mockResolvedValue(null) };
    const service = await buildService(prismaMock, rolesMock);

    await expect(service.updateRole('user-1', 'wizard', admin)).rejects.toThrow(NotFoundException);
  });
});
```

Add `ForbiddenException` to the existing `@nestjs/common` import in the spec, and add
`import type { AuthUser } from '../auth/jwt.strategy';`.

- [ ] **Step 3: Run them and watch them fail.**

```bash
cd backend && npm test -- users.service
```
Expected: FAIL — `service.updateStatus is not a function`.

- [ ] **Step 4: Implement.** In `backend/src/users/users.service.ts`: add `ForbiddenException` to the
      `@nestjs/common` import, add `import { RolesService } from './roles.service';` and
      `import type { AuthUser } from '../auth/jwt.strategy';`, change the constructor to

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
  ) {}
```

and add:

```typescript
  async updateStatus(id: string, status: 'active' | 'suspended', actor: AuthUser) {
    // Self-lockout guard: suspending yourself is never intentional.
    if (id === actor.id) throw new ForbiddenException('You cannot change your own status');

    await this.findById(id); // 404 if the target doesn't exist
    const user = await this.prisma.user.update({
      where: { id },
      data: { status },
      include: { role: { select: { id: true, name: true } } },
    });
    return toSafeUser(user);
  }

  async updateRole(id: string, roleName: string, actor: AuthUser) {
    // Self-escalation guard. `user.manage` belongs to `admin`; without this rule an
    // admin could promote themselves to super_admin and inherit every permission in
    // the system — including withdrawal.approve, deliberately withheld from them.
    if (id === actor.id) throw new ForbiddenException('You cannot change your own role');

    // ...and blocking self-promotion is pointless if an admin can crown an accomplice.
    if (roleName === 'super_admin' && actor.role !== 'super_admin') {
      throw new ForbiddenException('Only a super_admin may assign the super_admin role');
    }

    const role = await this.roles.findByName(roleName);
    if (!role) throw new NotFoundException(`Unknown role: ${roleName}`);

    await this.findById(id); // 404 if the target doesn't exist
    const user = await this.prisma.user.update({
      where: { id },
      data: { roleId: role.id },
      include: { role: { select: { id: true, name: true } } },
    });
    return toSafeUser(user);
  }
```

- [ ] **Step 5: Green.**

```bash
cd backend && npm test -- users.service
```
Expected: 10 tests passing (the 4 from Task 3 plus 6 new).

- [ ] **Step 6: The DTOs.** `backend/src/users/dto/update-user-status.dto.ts`:

```typescript
import { IsIn } from 'class-validator';

export class UpdateUserStatusDto {
  @IsIn(['active', 'suspended'])
  status!: 'active' | 'suspended';
}
```

`backend/src/users/dto/update-user-role.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class UpdateUserRoleDto {
  // A role *name* (e.g. 'finance'), not an id — names are stable seed data and
  // make the API readable. UsersService.updateRole resolves it, 404 if unknown.
  @IsString()
  @MinLength(1)
  role!: string;
}
```

- [ ] **Step 7: The routes.** In `backend/src/users/users.controller.ts`, add `Body`, `Patch` to the
      `@nestjs/common` import; add `import { CurrentUser } from '../auth/current-user.decorator';`,
      **`import type { AuthUser } from '../auth/jwt.strategy';`** (`import type` is mandatory —
      `AuthUser` appears in a decorated signature, and a plain import fails with TS1272; this exact
      error bit us in M2 Task 5), and both DTO imports. Then add:

```typescript
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.users.updateStatus(id, dto.status, actor);
  }

  @Patch(':id/role')
  updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.users.updateRole(id, dto.role, actor);
  }
```

- [ ] **Step 8: Verify end-to-end — including the payoff.** Server running:

```bash
ADMIN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@wallet.local","password":"ChangeMe123!"}' | jq -r .accessToken)
TARGET=$(curl -s "http://localhost:3000/users?take=100" -H "Authorization: Bearer $ADMIN" \
  | jq -r '.users[] | select(.email=="refactor-check@example.com") | .id')

# Promote them to finance.
curl -s -X PATCH "http://localhost:3000/users/$TARGET/role" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"role":"finance"}'
```
Expected: `200`, `role.name` now `finance`.

```bash
# Put it back.
curl -s -w '\n%{http_code}\n' -X PATCH "http://localhost:3000/users/$TARGET/role" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"role":"user"}'
```
Expected: `200`, back to `user`.

> The *denial* half of the super_admin rule isn't curl-able here: `$ADMIN` is the seeded
> **super_admin**, so it is correctly allowed to assign `super_admin`. Reproducing the refusal would
> mean standing up a real `admin`-role account and logging in as it. The unit tests in Step 2 cover
> both sides directly, which is exactly what unit tests are for.

```bash
# THE PAYOFF: suspend a user, then watch their still-valid token stop working
# immediately — not in 15 minutes. This is why the guard reads the DB.
CUSTOMER=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"refactor-check@example.com","password":"Password123"}' | jq -r .accessToken)

curl -s -X PATCH "http://localhost:3000/users/$TARGET/role" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"role":"admin"}'

# That freshly-minted CUSTOMER token predates the promotion, yet works instantly:
curl -s -w '\n%{http_code}\n' http://localhost:3000/users -H "Authorization: Bearer $CUSTOMER"
```
Expected: `200`. **The token still says `role: "user"` — decode it and see.** The guard ignored the
token's claim and asked the database. Under the JWT-claims design (spec §2 option A) this would have
been a 403 for another 15 minutes.

```bash
curl -s -X PATCH "http://localhost:3000/users/$TARGET/status" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"status":"suspended"}'

curl -s -w '\n%{http_code}\n' http://localhost:3000/users -H "Authorization: Bearer $CUSTOMER"
```
Expected: **`403 Account suspended`** — same unexpired token, revoked the instant the admin acted.

```bash
# Cleanup: reactivate and demote.
curl -s -X PATCH "http://localhost:3000/users/$TARGET/status" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"status":"active"}'
curl -s -X PATCH "http://localhost:3000/users/$TARGET/role" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"role":"user"}'
```

- [ ] **Step 9: Commit.**

```bash
git add backend/src/users
git commit -m "feat: add PATCH /users/:id/status and /role with separation-of-duties rules (Milestone 3, Task 4)"
```

---

## Task 5: Review, hardening, and learning notes

**Files:**
- Modify: `docs/learning-notes.md`
- Possibly modify: any file the review turns up

- [ ] **Step 1: Full verification.**

```bash
cd backend && npx tsc --noEmit && npm test
```
Expected: tsc silent; **6 suites, 28 tests** — 13 from M2, + 5 (`permissions.guard`), + 10
(`users.service`: 4 from Task 3, 6 from Task 4). If the count differs, find out why before ticking
this box.

- [ ] **Step 2: Run the spec's self-review checklist** (§9 of
      `../specs/2026-07-17-wallet-milestone-3-rbac-design.md`) and tick each box:
  - [ ] A `user`-role account receives 403 on every `/users` route.
  - [ ] A suspended user's still-valid access token receives 403 immediately — not after 15 minutes.
  - [ ] An `admin` cannot promote themselves or anyone else to `super_admin`.
  - [ ] No response anywhere includes `passwordHash`.

- [ ] **Step 3: Read the diff with fresh eyes.** `git diff 426d2fb..HEAD -- backend/`. Specifically
      check: is any `prisma.user` access left outside `UsersService`? Does any route return a raw
      Prisma row? Is `@RequirePermissions` on every admin route? Fix what you find, commit separately.

- [ ] **Step 4: Append to `docs/learning-notes.md`** — the M3 sections. Cover, in plain English:
  - **RBAC vs authentication** — 401 vs 403; identity vs privilege; why the guard order is fixed.
  - **Why the guard reads the DB, not the token** — the spec §2 A/B/C table, and the "a signed token
    cannot be un-issued" point. Include the Task 4 Step 8 demo (suspend → instant 403 on an unexpired
    token) as the concrete proof.
  - **`SetMetadata` + `Reflector`** — how a decorator that "does nothing" and a guard that reads it
    combine; `getAllAndOverride` and handler-beats-class precedence. Contrast with `@CurrentUser`
    (reads at call time) vs `@RequirePermissions` (writes at definition time).
  - **Separation of duties** — the admin-self-promotion hole and the two rules that close it; why
    delegation (admin grants `finance`) is *allowed* and audited rather than blocked.
  - **What a refactor is** — Task 1: assertions unchanged, mock wiring rewired. Mock-based unit tests
    are coupled to *who a class talks to*, which is the price of isolation.
  - **Deliberate non-goals and why** — no roles CRUD (it is an escalation vector), no caching (it
    trades correctness for a performance problem we don't have), no refresh-revoke on suspend (it
    would force a circular module dependency for a hole nothing can exploit yet — revisit in M4).

- [ ] **Step 5: Milestone recap section** in `docs/learning-notes.md`, following the M2 recap's shape:
      an endpoint table (method / path / permission / who can call it), the request lifecycle from
      `Authorization: Bearer` header through `JwtAuthGuard` → `JwtStrategy` → `request.user` →
      `PermissionsGuard` → handler, and the deferred-hardening list.

- [ ] **Step 6: Commit.**

```bash
git add docs/learning-notes.md
git commit -m "docs: consolidate Milestone 3 learning notes (Milestone 3, Task 5)"
```

- [ ] **Step 7: Update the project memory** at
      `/Users/max/.claude/projects/-Users-max-Documents-GitHub-wallet-system/memory/wallet-system-project.md`:
      mark M3 complete with its commit range and the per-task ✅ list, and set
      `⏭ NEXT: Milestone 4 (Wallet + Ledger)`.

---

## Milestone 3 self-review checklist (run before starting Milestone 4)

- [ ] `npm test` green; `npx tsc --noEmit` clean.
- [ ] The repo has clean commits, one per task.
- [ ] **You can explain:** why the guard queries the DB instead of trusting the token; the difference
      between 401 and 403; why `PermissionsGuard` is unit-tested when `JwtAuthGuard` was not; why
      permission-gating and ownership-gating are separate mechanisms; and what the two
      separation-of-duties rules protect against. If any of these is fuzzy, revisit before moving on —
      understanding is the point.

---

## What Milestone 4 will cover (preview, not yet detailed)

Wallets and the immutable ledger: `Wallet` and `Transaction` models, deposit/withdrawal **requests**
that a `finance` user approves (using `deposit.approve` / `withdrawal.approve` — permissions that exist
in the seed and finally get consumed), atomic settlement inside DB transactions, `balance_before` /
`balance_after` chain integrity, and race-condition handling. Customer-facing wallet routes will be
**ownership-gated**, which is where the status-check rule from spec §3 gets extended to the ownership
guard.
