import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WalletsService } from './wallets.service';

@Module({
  imports: [UsersModule],
  providers: [WalletsService],
})
export class WalletsModule {}
