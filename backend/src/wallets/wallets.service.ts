import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
