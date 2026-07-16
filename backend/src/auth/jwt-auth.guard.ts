import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Attach with @UseGuards(JwtAuthGuard) to require a valid access token.
 * 'jwt' is the default name of the JwtStrategy we registered — this guard
 * simply runs that strategy and returns 401 if it fails.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
