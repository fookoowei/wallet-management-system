import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { RolesService } from './roles.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/jwt.strategy';

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
