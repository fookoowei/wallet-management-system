import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import type { AuthUser } from '../auth/jwt.strategy';

const actor: AuthUser = { id: 'user-1', email: 'u1@example.com', role: 'user' };
const other: AuthUser = { id: 'user-2', email: 'u2@example.com', role: 'user' };

function buildService(
  prismaMock: any,
  usersMock: any = { findByIdWithPermissions: jest.fn() },
) {
  return Test.createTestingModule({
    providers: [
      WalletsService,
      { provide: PrismaService, useValue: prismaMock },
      { provide: UsersService, useValue: usersMock },
    ],
  })
    .compile()
    .then((moduleRef) => moduleRef.get(WalletsService));
}

const wallet = (over: Partial<any> = {}) => ({
  id: 'wallet-1',
  userId: 'user-1',
  name: 'main',
  currency: 'USD',
  balance: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('WalletsService.createWallet', () => {
  it('creates a wallet owned by the actor', async () => {
    const prismaMock = { wallet: { create: jest.fn().mockResolvedValue(wallet()) } };
    const service = await buildService(prismaMock);

    await service.createWallet(actor, { name: 'main', currency: 'USD' });

    expect(prismaMock.wallet.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', name: 'main', currency: 'USD' }),
      }),
    );
  });
});

describe('WalletsService.listWallets', () => {
  it('returns only the actor’s wallets', async () => {
    const prismaMock = { wallet: { findMany: jest.fn().mockResolvedValue([wallet()]) } };
    const service = await buildService(prismaMock);

    await service.listWallets(actor);

    expect(prismaMock.wallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });
});

describe('WalletsService.getWallet (ownership)', () => {
  it('returns the wallet when the actor owns it', async () => {
    const prismaMock = { wallet: { findUnique: jest.fn().mockResolvedValue(wallet()) } };
    const service = await buildService(prismaMock);

    const result = await service.getWallet('wallet-1', actor);

    expect(result.id).toBe('wallet-1');
  });

  it('throws NotFoundException when the wallet does not exist', async () => {
    const prismaMock = { wallet: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = await buildService(prismaMock);

    await expect(service.getWallet('ghost', actor)).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when the wallet belongs to someone else', async () => {
    const prismaMock = { wallet: { findUnique: jest.fn().mockResolvedValue(wallet()) } };
    const service = await buildService(prismaMock);

    await expect(service.getWallet('wallet-1', other)).rejects.toThrow(ForbiddenException);
  });
});

describe('WalletsService.listTransactions (ownership)', () => {
  it('lists a wallet’s transactions for the owner', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet()) },
      transaction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = await buildService(prismaMock);

    await service.listTransactions('wallet-1', actor);

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: 'wallet-1' } }),
    );
  });

  it('refuses a non-owner before reading transactions', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet()) },
      transaction: { findMany: jest.fn() },
    };
    const service = await buildService(prismaMock);

    await expect(service.listTransactions('wallet-1', other)).rejects.toThrow(ForbiddenException);
    expect(prismaMock.transaction.findMany).not.toHaveBeenCalled();
  });
});
