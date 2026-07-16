import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from './jwt.strategy';

/**
 * Injects the authenticated user (what JwtStrategy.validate returned) into a
 * handler parameter: `me(@CurrentUser() user: AuthUser)`. Only meaningful on
 * routes guarded by JwtAuthGuard — otherwise request.user is undefined.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
