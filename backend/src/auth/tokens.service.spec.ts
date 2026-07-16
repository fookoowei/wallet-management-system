import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { TokensService } from './tokens.service';
import { PrismaService } from '../prisma/prisma.service';

const user = {
  id: 'user-1',
  email: 'alice@example.com',
  role: { name: 'user' },
};

describe('TokensService.issueTokens', () => {
  it('signs an access token and stores a HASHED refresh token', async () => {
    const jwtMock = { signAsync: jest.fn().mockResolvedValue('signed.access.jwt') };
    const prismaMock = {
      refreshToken: { create: jest.fn().mockResolvedValue({}) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TokensService,
        { provide: JwtService, useValue: jwtMock },
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    const service = moduleRef.get(TokensService);

    const result = await service.issueTokens(user);

    // Access token is whatever the JwtService signed, with the right claims.
    expect(result.accessToken).toBe('signed.access.jwt');
    expect(jwtMock.signAsync).toHaveBeenCalledWith({
      sub: 'user-1',
      email: 'alice@example.com',
      role: 'user',
    });

    // Refresh token is a non-empty opaque string handed back to the caller.
    expect(typeof result.refreshToken).toBe('string');
    expect(result.refreshToken.length).toBeGreaterThan(0);

    // What we STORE must be the hash, not the raw token, and tied to the user.
    const stored = prismaMock.refreshToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBeDefined();
    expect(stored.tokenHash).not.toBe(result.refreshToken);
    expect(stored.userId).toBe('user-1');
    expect(stored.expiresAt).toBeInstanceOf(Date);
  });
});
