import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import type { AuthUser } from '../auth/jwt.strategy';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { RatesService } from '../rates/rates.service';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly rates: RatesService,
  ) {}

  createWallet(actor: AuthUser, dto: { name: string; currency: string }) {
    return this.prisma.wallet.create({
      data: { userId: actor.id, name: dto.name, currency: dto.currency },
    });
  }

  listWallets(actor: AuthUser) {
    return this.prisma.wallet.findMany({
      where: { userId: actor.id },
      orderBy: { createdAt: 'asc' },
    });
  }

  getWallet(id: string, actor: AuthUser) {
    return this.getOwnedWallet(id, actor);
  }

  async listTransactions(id: string, actor: AuthUser) {
    await this.getOwnedWallet(id, actor); // 404 if missing, 403 if not owned
    return this.prisma.transaction.findMany({
      where: { walletId: id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async requestDeposit(id: string, actor: AuthUser, amount: number, note?: string) {
    await this.getOwnedWallet(id, actor);
    return this.prisma.transaction.create({
      data: { walletId: id, type: 'deposit', amount, status: 'pending', requestedBy: actor.id, note },
    });
  }

  async requestWithdrawal(id: string, actor: AuthUser, amount: number, note?: string) {
    const wallet = await this.getOwnedWallet(id, actor);
    // Friendly, NON-authoritative pre-check: fail obvious cases early so a customer
    // isn't left with a doomed pending request. The authoritative check is at approval
    // (the balance can change between request and approval).
    if (wallet.balance < amount) throw new BadRequestException('Insufficient funds');
    return this.prisma.transaction.create({
      data: { walletId: id, type: 'withdrawal', amount, status: 'pending', requestedBy: actor.id, note },
    });
  }

  listPending() {
    return this.prisma.transaction.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
  }

  async approve(txnId: string, actor: AuthUser) {
    // Permission check runs BEFORE the transaction opens: it needs only `type`, which is
    // immutable, and it does unrelated I/O (a user+permissions read). Doing it under the
    // row lock would hold that lock across an extra round-trip and borrow a second pool
    // connection while holding the first — a pool-starvation deadlock under load.
    await this.assertApprovePermission(actor, await this.getSettleableType(txnId));

    return this.prisma.$transaction(async (tx) => {
      // Lock the transaction row first (fixed order: txn, then wallet).
      await tx.$queryRaw`SELECT id FROM "Transaction" WHERE id = ${txnId} FOR UPDATE`;
      const txn = await tx.transaction.findUnique({ where: { id: txnId } });
      if (!txn) throw new NotFoundException('Transaction not found');
      // Re-checked under the lock: unlike `type`, status CAN change between the two reads.
      if (txn.status !== 'pending') throw new ConflictException('Transaction already reviewed');

      // Lock the wallet row, then read its true current balance.
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${txn.walletId} FOR UPDATE`;
      const wallet = await tx.wallet.findUnique({ where: { id: txn.walletId } });
      if (!wallet) throw new NotFoundException('Wallet not found');

      const before = wallet.balance;
      let after: number;
      if (txn.type === 'withdrawal') {
        if (before < txn.amount) throw new BadRequestException('Insufficient funds');
        after = before - txn.amount;
      } else {
        after = before + txn.amount; // deposit
      }

      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: after } });
      return tx.transaction.update({
        where: { id: txn.id },
        data: {
          status: 'approved',
          reviewedBy: actor.id,
          reviewedAt: new Date(),
          balanceBefore: before,
          balanceAfter: after,
        },
      });
    });
  }

  async reject(txnId: string, actor: AuthUser, note?: string) {
    await this.assertApprovePermission(actor, await this.getSettleableType(txnId));

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Transaction" WHERE id = ${txnId} FOR UPDATE`;
      const txn = await tx.transaction.findUnique({ where: { id: txnId } });
      if (!txn) throw new NotFoundException('Transaction not found');
      if (txn.status !== 'pending') throw new ConflictException('Transaction already reviewed');

      return tx.transaction.update({
        where: { id: txn.id },
        data: {
          status: 'rejected',
          reviewedBy: actor.id,
          reviewedAt: new Date(),
          note: note ?? txn.note,
        },
      });
    });
  }

  /**
   * Finance-only direct correction/bonus. No pending stage: locks the wallet, applies a
   * credit or debit, and writes an already-settled adjustment row — all atomically.
   * Route-gated by wallet.adjust (permission), so no per-type check here.
   */
  async adjust(
    walletId: string,
    dto: { direction: 'credit' | 'debit'; amount: number; note: string },
    actor: AuthUser,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${walletId} FOR UPDATE`;
      const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
      if (!wallet) throw new NotFoundException('Wallet not found');

      const before = wallet.balance;
      const after = dto.direction === 'credit' ? before + dto.amount : before - dto.amount;
      if (after < 0) throw new BadRequestException('Adjustment would make the balance negative');

      await tx.wallet.update({ where: { id: walletId }, data: { balance: after } });
      return tx.transaction.create({
        data: {
          walletId,
          type: 'adjustment',
          amount: dto.amount,
          balanceBefore: before,
          balanceAfter: after,
          status: 'approved',
          requestedBy: actor.id,
          reviewedBy: actor.id,
          reviewedAt: new Date(),
          note: dto.note,
        },
      });
    });
  }

  /**
   * Instant wallet-to-wallet transfer. Same currency: moves `amount` unchanged (M4b). Different
   * currencies: fetches a live rate BEFORE the transaction opens (never hold locks across an external
   * call), converts with banker's rounding, and records the rate on both linked ledger rows.
   */
  async transfer(
    fromWalletId: string,
    actor: AuthUser,
    dto: { toWalletId: string; amount: number; note?: string },
  ) {
    // Checked before the transaction: locking one row twice is meaningless, and the
    // arithmetic below would double-count a single wallet.
    if (dto.toWalletId === fromWalletId) {
      throw new BadRequestException('Cannot transfer to the same wallet');
    }

    // Ownership of the SOURCE only, before the transaction opens. Returns the wallet (immutable
    // currency is all we need from it here; the mutable balance is re-read under the lock).
    const source = await this.getOwnedWallet(fromWalletId, actor);

    // Destination existence + currency, read before the lock. `currency` is immutable per wallet,
    // so reading it early is safe (same reasoning as M4a's `type`).
    const dest = await this.prisma.wallet.findUnique({ where: { id: dto.toWalletId } });
    if (!dest) throw new NotFoundException('Destination wallet not found');

    // Fetch the rate BEFORE the lock — an external HTTP call must never run while holding two wallet
    // locks. With `amount` (caller-supplied) and the rate both known, the entire conversion is
    // determined here, before anything is locked. Same currency => no rate call, credit == amount.
    let exchangeRate: Prisma.Decimal | null = null;
    let credit = dto.amount;
    if (source.currency !== dest.currency) {
      exchangeRate = await this.rates.getRate(source.currency, dest.currency); // 503 on failure
      credit = new Prisma.Decimal(dto.amount)
        .times(exchangeRate)
        .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_EVEN) // banker's rounding
        .toNumber();
    }

    const transferId = randomUUID();
    // Deterministic lock order. NOT sender-then-receiver: if it were, Alice->Bob and
    // Bob->Alice running concurrently would each hold the row the other needs, and
    // Postgres would kill one for deadlock. Sorted, both lock the same wallet first.
    const [firstLock, secondLock] = [fromWalletId, dto.toWalletId].sort();

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${firstLock} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${secondLock} FOR UPDATE`;

      // Re-read under the locks: only the balances are mutable and must be trusted here.
      const from = await tx.wallet.findUnique({ where: { id: fromWalletId } });
      if (!from) throw new NotFoundException('Wallet not found');
      const to = await tx.wallet.findUnique({ where: { id: dto.toWalletId } });
      if (!to) throw new NotFoundException('Destination wallet not found');

      if (from.balance < dto.amount) throw new BadRequestException('Insufficient funds');

      const fromAfter = from.balance - dto.amount;
      const toAfter = to.balance + credit;
      const settledAt = new Date();

      await tx.wallet.update({ where: { id: from.id }, data: { balance: fromAfter } });
      await tx.wallet.update({ where: { id: to.id }, data: { balance: toAfter } });

      // Shared across both halves. `amount` is NOT shared — each row records its OWN currency's
      // amount (the debit on the sender, the converted credit on the receiver). `exchangeRate` is
      // the same on both (null for a same-currency transfer).
      const shared = {
        transferId,
        status: 'approved',
        requestedBy: actor.id,
        reviewedBy: actor.id,
        reviewedAt: settledAt,
        note: dto.note,
        exchangeRate,
      };

      const outRow = await tx.transaction.create({
        data: {
          ...shared,
          walletId: from.id,
          type: 'transfer_out',
          amount: dto.amount,
          counterpartyWalletId: to.id,
          balanceBefore: from.balance,
          balanceAfter: fromAfter,
        },
      });

      await tx.transaction.create({
        data: {
          ...shared,
          walletId: to.id,
          type: 'transfer_in',
          amount: credit,
          counterpartyWalletId: from.id,
          balanceBefore: to.balance,
          balanceAfter: toAfter,
        },
      });

      // Only the sender's row is returned: the receiver's row carries their balance,
      // which the sender has no right to see.
      return outRow;
    });
  }

  /**
   * The transaction's `type`, read outside any lock. Safe to read early because `type` is
   * written once at request time and never changes; everything mutable is re-read under the
   * lock. Returns 404 here so a bad id fails before we bother taking locks.
   */
  private async getSettleableType(txnId: string) {
    const txn = await this.prisma.transaction.findUnique({
      where: { id: txnId },
      select: { type: true },
    });
    if (!txn) throw new NotFoundException('Transaction not found');
    return txn.type;
  }

  /**
   * Approving a deposit needs deposit.approve; a withdrawal needs withdrawal.approve.
   * Which one is required depends on the row's type, so the check is here, not in a
   * static route guard. Permissions are read from the DB (never the token) — M3's rule.
   */
  private async assertApprovePermission(actor: AuthUser, type: string) {
    const code = type === 'withdrawal' ? 'withdrawal.approve' : 'deposit.approve';
    const user = await this.users.findByIdWithPermissions(actor.id);
    const held = new Set(user?.role.permissions.map((permission) => permission.code) ?? []);
    if (!held.has(code)) throw new ForbiddenException('Access denied');
  }

  /**
   * Ownership-gating: load a wallet and confirm the caller owns it.
   * The check lives here (not a guard) because it depends on the loaded row.
   */
  private async getOwnedWallet(id: string, actor: AuthUser) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (wallet.userId !== actor.id) throw new ForbiddenException('Access denied');
    return wallet;
  }
}
