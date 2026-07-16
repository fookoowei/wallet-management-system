import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const REFRESH_TTL_DAYS = 7;

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /** Deterministic hash so we can look a token up by its hash later. */
  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issueTokens(user: { id: string; email: string; role: { name: string } }) {
    // Access token: a stateless, signed JWT (verified by signature alone, no DB).
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role.name,
    });

    // Refresh token: an opaque random string. Its authority lives in the DB row,
    // and we store only its SHA-256 hash — never the raw value.
    const refreshToken = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hash(refreshToken),
        userId: user.id,
        expiresAt,
      },
    });

    return { accessToken, refreshToken };
  }

  /**
   * Exchange a valid refresh token for a fresh pair. The presented token is
   * single-use: it is deleted the moment it's used, so a stolen-then-reused
   * token fails (whoever presents it second gets a 401).
   */
  async rotate(rawRefreshToken: string) {
    const tokenHash = this.hash(rawRefreshToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { role: true } } },
    });

    // No row = unknown, already-used, or revoked token.
    if (!existing) throw new UnauthorizedException('Invalid refresh token');

    // Expired: clean up the stale row and reject.
    if (existing.expiresAt.getTime() < Date.now()) {
      await this.prisma.refreshToken.delete({ where: { id: existing.id } });
      throw new UnauthorizedException('Refresh token expired');
    }

    // Single-use: burn the presented token before minting a new pair.
    await this.prisma.refreshToken.delete({ where: { id: existing.id } });
    return this.issueTokens(existing.user);
  }

  /** Log out one device: delete its refresh-token row. Idempotent. */
  async revoke(rawRefreshToken: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({
      where: { tokenHash: this.hash(rawRefreshToken) },
    });
  }
}
