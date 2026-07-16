import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { TokensService } from './tokens.service';
import { PrismaService } from '../prisma/prisma.service';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const user = {
  id: 'user-1',
  email: 'alice@example.com',
  role: { name: 'user' },
};

// Build a fresh TokensService wired to mocked JwtService + PrismaService.
function buildService(jwtMock: any, prismaMock: any) {
  return Test.createTestingModule({
    providers: [
      TokensService,
      { provide: JwtService, useValue: jwtMock },
      { provide: PrismaService, useValue: prismaMock },
    ],
  })
    .compile()
    .then((moduleRef) => moduleRef.get(TokensService));
}

describe('TokensService.issueTokens', () => {
  it('signs an access token and stores a HASHED refresh token', async () => {
    const jwtMock = { signAsync: jest.fn().mockResolvedValue('signed.access.jwt') };
    const prismaMock = { refreshToken: { create: jest.fn().mockResolvedValue({}) } };
    const service = await buildService(jwtMock, prismaMock);

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

describe('TokensService.rotate', () => {
  const raw = 'raw-refresh-token-value';

  it('deletes the used token (single-use) and issues a fresh pair', async () => {
    const row = {
      id: 'rt-1',
      tokenHash: sha256(raw),
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000), // still valid
      user,
    };
    const prismaMock = {
      refreshToken: {
        findUnique: jest.fn().mockResolvedValue(row),
        delete: jest.fn().mockResolvedValue(row),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const jwtMock = { signAsync: jest.fn().mockResolvedValue('new.access.jwt') };
    const service = await buildService(jwtMock, prismaMock);
    // Isolate rotate's own logic from issueTokens' internals.
    const issueSpy = jest
      .spyOn(service, 'issueTokens')
      .mockResolvedValue({ accessToken: 'new.access.jwt', refreshToken: 'new-refresh' });

    const result = await service.rotate(raw);

    // Looked the row up by the HASH of the raw token (never the raw value).
    expect(prismaMock.refreshToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: sha256(raw) },
      include: { user: { include: { role: true } } },
    });
    // The presented token row is deleted → single-use.
    expect(prismaMock.refreshToken.delete).toHaveBeenCalledWith({ where: { id: 'rt-1' } });
    // A fresh pair is minted for the row's user.
    expect(issueSpy).toHaveBeenCalledWith(user);
    expect(result).toEqual({ accessToken: 'new.access.jwt', refreshToken: 'new-refresh' });
  });

  it('throws UnauthorizedException when the token is unknown (used/revoked)', async () => {
    const prismaMock = {
      refreshToken: {
        findUnique: jest.fn().mockResolvedValue(null),
        delete: jest.fn(),
        create: jest.fn(),
      },
    };
    const service = await buildService({ signAsync: jest.fn() }, prismaMock);
    const issueSpy = jest.spyOn(service, 'issueTokens');

    await expect(service.rotate(raw)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it('rejects and cleans up an expired token', async () => {
    const row = {
      id: 'rt-expired',
      tokenHash: sha256(raw),
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1_000), // already expired
      user,
    };
    const prismaMock = {
      refreshToken: {
        findUnique: jest.fn().mockResolvedValue(row),
        delete: jest.fn().mockResolvedValue(row),
        create: jest.fn(),
      },
    };
    const service = await buildService({ signAsync: jest.fn() }, prismaMock);
    const issueSpy = jest.spyOn(service, 'issueTokens');

    await expect(service.rotate(raw)).rejects.toBeInstanceOf(UnauthorizedException);
    // The stale row is removed even though we reject.
    expect(prismaMock.refreshToken.delete).toHaveBeenCalledWith({ where: { id: 'rt-expired' } });
    expect(issueSpy).not.toHaveBeenCalled();
  });
});

describe('TokensService.revoke', () => {
  it('deletes the row matching the token hash (idempotent logout)', async () => {
    const raw = 'some-refresh-token';
    const prismaMock = {
      refreshToken: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = await buildService({ signAsync: jest.fn() }, prismaMock);

    await service.revoke(raw);

    expect(prismaMock.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: sha256(raw) },
    });
  });
});
