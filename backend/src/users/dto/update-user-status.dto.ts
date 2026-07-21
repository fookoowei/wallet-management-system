import { IsIn } from 'class-validator';

export class UpdateUserStatusDto {
  @IsIn(['active', 'suspended'])
  status!: 'active' | 'suspended';
}
