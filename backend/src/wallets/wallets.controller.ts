import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';

// JwtAuthGuard only: there is no *permission* a customer holds to read their own
// wallet. Ownership is enforced in the service, because it depends on the row.
@Controller('wallets')
@UseGuards(JwtAuthGuard)
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateWalletDto) {
    return this.wallets.createWallet(actor, dto);
  }

  @Get()
  list(@CurrentUser() actor: AuthUser) {
    return this.wallets.listWallets(actor);
  }

  @Get(':id')
  getOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.wallets.getWallet(id, actor);
  }

  @Get(':id/transactions')
  listTransactions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.wallets.listTransactions(id, actor);
  }
}
