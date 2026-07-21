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
