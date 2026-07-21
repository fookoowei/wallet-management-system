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
