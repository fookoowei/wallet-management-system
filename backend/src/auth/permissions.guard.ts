import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UsersService } from '../users/users.service';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import type { AuthUser } from './jwt.strategy';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Handler metadata wins over controller metadata, so a route can be stricter
    // than the class-level default.
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // A route that never asked for a permission is not this guard's business.
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const identity: AuthUser | undefined = request.user;
    // No identity means JwtAuthGuard didn't run before us — a wiring mistake, not an
    // attack. Fail closed rather than assume.
    if (!identity) throw new ForbiddenException('Access denied');

    // Read authority from the DB, never from the token: a JWT minted before a
    // suspension or role change still carries the old authority and cannot be un-issued.
    const user = await this.users.findByIdWithPermissions(identity.id);
    if (!user) throw new ForbiddenException('Access denied');
    if (user.status !== 'active') throw new ForbiddenException('Account suspended');

    const held = new Set(user.role.permissions.map((permission) => permission.code));
    if (!required.every((code) => held.has(code))) {
      // Deliberately vague: the caller learns they may not act, not the shape of
      // the permission model.
      throw new ForbiddenException('Access denied');
    }

    return true;
  }
}
