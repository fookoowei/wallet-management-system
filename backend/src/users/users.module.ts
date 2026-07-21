import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { RolesService } from './roles.service';

@Module({
  providers: [UsersService, RolesService],
  exports: [UsersService, RolesService],
})
export class UsersModule {}
