import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { WalletsService } from './wallets.service';
import { RejectDto } from './dto/reject.dto';

// `transaction.view_all` is the coarse gate — it decides who may see the queue at all.
// The *type-specific* approve permission (deposit.approve vs withdrawal.approve) is
// enforced in the service, because it depends on the loaded row's type.
@Controller('transactions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('transaction.view_all')
export class TransactionsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get('pending')
  pending() {
    return this.wallets.listPending();
  }

  @Post(':id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.wallets.approve(id, actor);
  }

  @Post(':id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: RejectDto,
  ) {
    return this.wallets.reject(id, actor, dto.note);
  }
}
