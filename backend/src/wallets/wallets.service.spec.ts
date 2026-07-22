import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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

describe('WalletsService.requestDeposit', () => {
  it('creates a pending deposit and changes no balance', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet({ balance: 500 })) },
      transaction: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) },
    };
    const service = await buildService(prismaMock);

    const result = await service.requestDeposit('wallet-1', actor, 1000, 'salary');

    expect(prismaMock.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          walletId: 'wallet-1', type: 'deposit', amount: 1000, status: 'pending', requestedBy: 'user-1',
        }),
      }),
    );
    expect(result.balanceBefore).toBeUndefined(); // pending rows carry no settled balance
  });

  it('refuses to deposit into a wallet the actor does not own', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet()) },
      transaction: { create: jest.fn() },
    };
    const service = await buildService(prismaMock);

    await expect(service.requestDeposit('wallet-1', other, 1000)).rejects.toThrow(ForbiddenException);
    expect(prismaMock.transaction.create).not.toHaveBeenCalled();
  });
});

describe('WalletsService.requestWithdrawal', () => {
  it('creates a pending withdrawal when funds appear sufficient', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })) },
      transaction: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) },
    };
    const service = await buildService(prismaMock);

    await service.requestWithdrawal('wallet-1', actor, 2000);

    expect(prismaMock.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'withdrawal', amount: 2000, status: 'pending' }),
      }),
    );
  });

  it('rejects an obviously-insufficient withdrawal request early (friendly 400)', async () => {
    const prismaMock = {
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet({ balance: 100 })) },
      transaction: { create: jest.fn() },
    };
    const service = await buildService(prismaMock);

    await expect(service.requestWithdrawal('wallet-1', actor, 2000)).rejects.toThrow(BadRequestException);
    expect(prismaMock.transaction.create).not.toHaveBeenCalled();
  });
});

const finance: AuthUser = { id: 'fin-1', email: 'fin@wallet.local', role: 'finance' };

// A finance user holding both approve permissions, as findByIdWithPermissions returns them.
const financeCanApprove = {
  findByIdWithPermissions: jest.fn().mockResolvedValue({
    id: 'fin-1',
    status: 'active',
    role: { permissions: [{ code: 'deposit.approve' }, { code: 'withdrawal.approve' }] },
  }),
};

const pendingTxn = (over: Partial<any> = {}) => ({
  id: 'txn-1',
  walletId: 'wallet-1',
  type: 'withdrawal',
  amount: 2000,
  status: 'pending',
  requestedBy: 'user-1',
  balanceBefore: null,
  balanceAfter: null,
  ...over,
});

// Build a prisma mock whose $transaction runs the callback against a tx double.
function txPrisma(txDouble: any, extra: any = {}) {
  return {
    $transaction: jest.fn().mockImplementation((cb: any) => cb(txDouble)),
    ...extra,
  };
}

describe('WalletsService.approve', () => {
  it('settles a withdrawal atomically and records the balance chain', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn()),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'txn-1', ...data })),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    const result = await service.approve('txn-1', finance);

    expect(txDouble.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wallet-1' }, data: { balance: 3000 } }),
    );
    expect(result.status).toBe('approved');
    expect(result.balanceBefore).toBe(5000);
    expect(result.balanceAfter).toBe(3000);
    expect(result.reviewedBy).toBe('fin-1');
  });

  it('settles a deposit by increasing the balance', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn({ type: 'deposit', amount: 1000 })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'txn-1', ...data })),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    const result = await service.approve('txn-1', finance);

    expect(result.balanceAfter).toBe(6000);
  });

  it('rejects an over-balance withdrawal with 400 and moves no money', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn({ amount: 9000 })),
        update: jest.fn(),
      },
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })), update: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    await expect(service.approve('txn-1', finance)).rejects.toThrow(BadRequestException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
    expect(txDouble.transaction.update).not.toHaveBeenCalled();
  });

  it('refuses to settle a non-pending request with 409 (double-approval guard)', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn({ status: 'approved' })),
        update: jest.fn(),
      },
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    await expect(service.approve('txn-1', finance)).rejects.toThrow(ConflictException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
  });

  it('throws 404 when the transaction does not exist', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    await expect(service.approve('ghost', finance)).rejects.toThrow(NotFoundException);
  });

  it('forbids an actor lacking the type-specific approve permission (403)', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: { findUnique: jest.fn().mockResolvedValue(pendingTxn()), update: jest.fn() },
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    // Holds deposit.approve but NOT withdrawal.approve; the txn is a withdrawal.
    const usersMock = {
      findByIdWithPermissions: jest.fn().mockResolvedValue({
        id: 'fin-1', status: 'active', role: { permissions: [{ code: 'deposit.approve' }] },
      }),
    };
    const service = await buildService(txPrisma(txDouble), usersMock);

    await expect(service.approve('txn-1', finance)).rejects.toThrow(ForbiddenException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
  });
});

describe('WalletsService.reject', () => {
  it('marks a pending request rejected without touching the balance', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn()),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'txn-1', ...data })),
      },
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    const result = await service.reject('txn-1', finance, 'suspicious');

    expect(result.status).toBe('rejected');
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
  });

  it('refuses to reject a non-pending request with 409', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      transaction: {
        findUnique: jest.fn().mockResolvedValue(pendingTxn({ status: 'rejected' })),
        update: jest.fn(),
      },
      wallet: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble), financeCanApprove);

    await expect(service.reject('txn-1', finance)).rejects.toThrow(ConflictException);
  });
});
