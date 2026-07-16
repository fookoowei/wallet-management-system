import { Test } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from './tokens.service';
import { RegisterDto } from './dto/register.dto';

const dto: RegisterDto = {
  email: 'alice@example.com',
  password: 'Password123',
  firstName: 'Alice',
  lastName: 'Lee',
};

// Build a fresh AuthService wired to mocked collaborators for each test.
function buildService(prismaMock: any, tokensMock: any = { issueTokens: jest.fn() }) {
  return Test.createTestingModule({
    providers: [
      AuthService,
      { provide: PrismaService, useValue: prismaMock },
      { provide: TokensService, useValue: tokensMock },
    ],
  })
    .compile()
    .then((moduleRef) => moduleRef.get(AuthService));
}

describe('AuthService.register', () => {
  it('hashes the password and returns the user without the hash', async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null), // email not taken
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: 'user-1',
            status: 'active',
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          }),
        ),
      },
      role: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'role-user', name: 'user' }),
      },
    };
    const service = await buildService(prismaMock);

    const result = await service.register(dto);

    // Return value must NOT leak the hash.
    expect(result).not.toHaveProperty('passwordHash');
    expect(result.email).toBe(dto.email);

    // What we stored must be a hash, not the plaintext password.
    const stored = prismaMock.user.create.mock.calls[0][0].data.passwordHash;
    expect(stored).toBeDefined();
    expect(stored).not.toBe(dto.password);

    // New account gets the default 'user' role.
    expect(prismaMock.user.create.mock.calls[0][0].data.roleId).toBe('role-user');
  });

  it('throws ConflictException when the email is already registered', async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'existing', email: dto.email }),
        create: jest.fn(),
      },
      role: { findUniqueOrThrow: jest.fn() },
    };
    const service = await buildService(prismaMock);

    await expect(service.register(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.login', () => {
  const credentials = { email: 'alice@example.com', password: 'Password123' };

  it('issues tokens when the email exists and the password matches', async () => {
    // Store a REAL bcrypt hash so the service's bcrypt.compare actually succeeds.
    const passwordHash = await bcrypt.hash(credentials.password, 10);
    const foundUser = {
      id: 'user-1',
      email: credentials.email,
      passwordHash,
      role: { name: 'user' },
    };
    const prismaMock = { user: { findUnique: jest.fn().mockResolvedValue(foundUser) } };
    const tokensMock = {
      issueTokens: jest.fn().mockResolvedValue({ accessToken: 'a.jwt', refreshToken: 'r-opaque' }),
    };
    const service = await buildService(prismaMock, tokensMock);

    const result = await service.login(credentials);

    // Returns exactly the token pair the factory produced.
    expect(result).toEqual({ accessToken: 'a.jwt', refreshToken: 'r-opaque' });
    // The factory was handed the found user (so tokens carry the right identity/role).
    expect(tokensMock.issueTokens).toHaveBeenCalledWith(foundUser);
  });

  it('throws UnauthorizedException when the password is wrong', async () => {
    const passwordHash = await bcrypt.hash('the-real-password', 10);
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          email: credentials.email,
          passwordHash,
          role: { name: 'user' },
        }),
      },
    };
    const tokensMock = { issueTokens: jest.fn() };
    const service = await buildService(prismaMock, tokensMock);

    await expect(service.login(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokensMock.issueTokens).not.toHaveBeenCalled(); // never issue tokens on failure
  });

  it('throws UnauthorizedException when the email is unknown', async () => {
    const prismaMock = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
    const tokensMock = { issueTokens: jest.fn() };
    const service = await buildService(prismaMock, tokensMock);

    await expect(service.login(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokensMock.issueTokens).not.toHaveBeenCalled();
  });
});
