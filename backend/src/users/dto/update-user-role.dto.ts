import { IsString, MinLength } from 'class-validator';

export class UpdateUserRoleDto {
  // A role *name* (e.g. 'finance'), not an id — names are stable seed data and
  // make the API readable. UsersService.updateRole resolves it, 404 if unknown.
  @IsString()
  @MinLength(1)
  role!: string;
}
