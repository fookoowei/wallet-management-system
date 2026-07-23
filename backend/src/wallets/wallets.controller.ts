import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { MoneyAmountDto } from './dto/money-amount.dto';
import { AdjustmentDto } from './dto/adjustment.dto';
import { TransferDto } from './dto/transfer.dto';

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

  @Post(':id/deposits')
  requestDeposit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: MoneyAmountDto,
  ) {
    return this.wallets.requestDeposit(id, actor, dto.amount, dto.note);
  }

  @Post(':id/withdrawals')
  requestWithdrawal(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: MoneyAmountDto,
  ) {
    return this.wallets.requestWithdrawal(id, actor, dto.amount, dto.note);
  }

  // Ownership-gated only, like the other customer routes: no permission is required to
  // move your own money. The destination is deliberately NOT ownership-checked.
  @Post(':id/transfers')
  transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: TransferDto,
  ) {
    return this.wallets.transfer(id, actor, dto);
  }

  // Finance-only: adjust ANY wallet (no ownership check — permission-gated, not owner-gated).
  // A method-level @UseGuards runs *in addition to* the class-level JwtAuthGuard.
  @Post(':id/adjustments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('wallet.adjust')
  adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustmentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.wallets.adjust(id, dto, actor);
  }
}
