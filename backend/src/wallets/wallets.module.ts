import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';

@Module({
  imports: [UsersModule],
  controllers: [WalletsController],
  providers: [WalletsService],
})
export class WalletsModule {}
