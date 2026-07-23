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
// The double is also spread at the root, because some reads (e.g. the pre-lock `type`
// lookup) deliberately run on the root client rather than inside the transaction.
function txPrisma(txDouble: any, extra: any = {}) {
  return {
    ...txDouble,
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

describe('WalletsService.adjust', () => {
  it('credits a wallet and writes a settled adjustment row', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })),
        update: jest.fn().mockResolvedValue(undefined),
      },
      transaction: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'adj-1', ...data })),
      },
    };
    const service = await buildService(txPrisma(txDouble));

    const result = await service.adjust('wallet-1', { direction: 'credit', amount: 1000, note: 'bonus' }, finance);

    expect(txDouble.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wallet-1' }, data: { balance: 6000 } }),
    );
    expect(result.type).toBe('adjustment');
    expect(result.status).toBe('approved');
    expect(result.balanceBefore).toBe(5000);
    expect(result.balanceAfter).toBe(6000);
  });

  it('debits a wallet', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet({ balance: 5000 })),
        update: jest.fn().mockResolvedValue(undefined),
      },
      transaction: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'adj-1', ...data })),
      },
    };
    const service = await buildService(txPrisma(txDouble));

    const result = await service.adjust('wallet-1', { direction: 'debit', amount: 2000, note: 'correction' }, finance);

    expect(result.balanceAfter).toBe(3000);
  });

  it('refuses a debit that would drive the balance below zero (400)', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      wallet: { findUnique: jest.fn().mockResolvedValue(wallet({ balance: 500 })), update: jest.fn() },
      transaction: { create: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble));

    await expect(
      service.adjust('wallet-1', { direction: 'debit', amount: 2000, note: 'oops' }, finance),
    ).rejects.toThrow(BadRequestException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
    expect(txDouble.transaction.create).not.toHaveBeenCalled();
  });

  it('throws 404 when the wallet does not exist', async () => {
    const txDouble = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      wallet: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
      transaction: { create: jest.fn() },
    };
    const service = await buildService(txPrisma(txDouble));

    await expect(
      service.adjust('ghost', { direction: 'credit', amount: 1000, note: 'x' }, finance),
    ).rejects.toThrow(NotFoundException);
  });
});

// Two wallets: 'wallet-1' owned by user-1 (the actor), 'wallet-2' owned by user-2.
// findUnique is id-aware so one mock serves both the pre-lock ownership read and the
// two reads inside the transaction.
function transferPrisma(overrides: Record<string, any> = {}) {
  const rows: Record<string, any> = {
    'wallet-1': wallet({ id: 'wallet-1', userId: 'user-1', balance: 5000 }),
    'wallet-2': wallet({ id: 'wallet-2', userId: 'user-2', balance: 100 }),
    ...overrides,
  };
  const txDouble = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    wallet: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(rows[where.id] ?? null)),
      update: jest.fn().mockResolvedValue(undefined),
    },
    transaction: {
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: `txn-${data.type}`, ...data }),
      ),
    },
  };
  return { txDouble, prisma: txPrisma(txDouble) };
}

describe('WalletsService.transfer', () => {
  it('writes a linked pair with a shared transferId and unbroken chains', async () => {
    const { txDouble, prisma } = transferPrisma();
    const service = await buildService(prisma);

    const result = await service.transfer('wallet-1', actor, {
      toWalletId: 'wallet-2',
      amount: 2000,
    });

    const [outRow, inRow] = txDouble.transaction.create.mock.calls.map((call: any[]) => call[0].data);

    expect(outRow.type).toBe('transfer_out');
    expect(outRow.walletId).toBe('wallet-1');
    expect(outRow.balanceBefore).toBe(5000);
    expect(outRow.balanceAfter).toBe(3000);
    expect(outRow.counterpartyWalletId).toBe('wallet-2');

    expect(inRow.type).toBe('transfer_in');
    expect(inRow.walletId).toBe('wallet-2');
    expect(inRow.balanceBefore).toBe(100);
    expect(inRow.balanceAfter).toBe(2100);
    expect(inRow.counterpartyWalletId).toBe('wallet-1');

    // One event: both halves carry the same id.
    expect(outRow.transferId).toBeTruthy();
    expect(inRow.transferId).toBe(outRow.transferId);

    // Both rows are settled at creation, credited to the sender.
    expect(outRow.status).toBe('approved');
    expect(inRow.status).toBe('approved');
    expect(inRow.requestedBy).toBe('user-1');

    // Only the sender's row is returned — the receiver's balance must not leak.
    expect(result.type).toBe('transfer_out');
  });

  it('debits the sender and credits the receiver by the same amount', async () => {
    const { txDouble, prisma } = transferPrisma();
    const service = await buildService(prisma);

    await service.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 2000 });

    expect(txDouble.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balance: 3000 },
    });
    expect(txDouble.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-2' },
      data: { balance: 2100 },
    });
  });

  it('locks both wallets in sorted-id order regardless of direction', async () => {
    // This is the deadlock-prevention property, asserted directly: whichever way the
    // money flows, the locks are taken in the same order.
    const forward = transferPrisma();
    const forwardService = await buildService(forward.prisma);
    await forwardService.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 100 });

    const backward = transferPrisma();
    const backwardService = await buildService(backward.prisma);
    await backwardService.transfer('wallet-2', other, { toWalletId: 'wallet-1', amount: 50 });

    // $queryRaw is a tagged template: call[0] is the strings array, call[1] the interpolated id.
    const lockedForward = forward.txDouble.$queryRaw.mock.calls.map((call: any[]) => call[1]);
    const lockedBackward = backward.txDouble.$queryRaw.mock.calls.map((call: any[]) => call[1]);

    expect(lockedForward).toEqual(['wallet-1', 'wallet-2']);
    expect(lockedBackward).toEqual(['wallet-1', 'wallet-2']);
  });

  it('rejects a transfer to the same wallet without opening a transaction', async () => {
    const { prisma } = transferPrisma();
    const service = await buildService(prisma);

    await expect(
      service.transfer('wallet-1', actor, { toWalletId: 'wallet-1', amount: 100 }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a cross-currency transfer and moves no money', async () => {
    const { txDouble, prisma } = transferPrisma({
      'wallet-2': wallet({ id: 'wallet-2', userId: 'user-2', balance: 100, currency: 'EUR' }),
    });
    const service = await buildService(prisma);

    await expect(
      service.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 100 }),
    ).rejects.toThrow(BadRequestException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
    expect(txDouble.transaction.create).not.toHaveBeenCalled();
  });

  it('rejects a transfer larger than the sender’s balance', async () => {
    const { txDouble, prisma } = transferPrisma();
    const service = await buildService(prisma);

    await expect(
      service.transfer('wallet-1', actor, { toWalletId: 'wallet-2', amount: 9000 }),
    ).rejects.toThrow(BadRequestException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
    expect(txDouble.transaction.create).not.toHaveBeenCalled();
  });

  it('refuses to send from a wallet the actor does not own', async () => {
    const { txDouble, prisma } = transferPrisma();
    const service = await buildService(prisma);

    // 'other' is user-2, who does not own wallet-1.
    await expect(
      service.transfer('wallet-1', other, { toWalletId: 'wallet-2', amount: 100 }),
    ).rejects.toThrow(ForbiddenException);
    expect(txDouble.transaction.create).not.toHaveBeenCalled();
  });

  it('throws 404 when the source wallet does not exist', async () => {
    const { prisma } = transferPrisma();
    const service = await buildService(prisma);

    await expect(
      service.transfer('ghost', actor, { toWalletId: 'wallet-2', amount: 100 }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws 404 when the destination wallet does not exist', async () => {
    const { txDouble, prisma } = transferPrisma();
    const service = await buildService(prisma);

    await expect(
      service.transfer('wallet-1', actor, { toWalletId: 'ghost', amount: 100 }),
    ).rejects.toThrow(NotFoundException);
    expect(txDouble.wallet.update).not.toHaveBeenCalled();
  });
});
