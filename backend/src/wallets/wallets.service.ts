import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import type { AuthUser } from '../auth/jwt.strategy';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
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
