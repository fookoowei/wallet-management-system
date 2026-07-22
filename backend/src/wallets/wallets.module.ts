import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { TransactionsController } from './transactions.controller';

@Module({
  imports: [UsersModule],
  controllers: [WalletsController, TransactionsController],
  providers: [WalletsService],
})
export class WalletsModule {}
