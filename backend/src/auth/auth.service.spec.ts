import { Test } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { RolesService } from '../users/roles.service';
import { TokensService } from './tokens.service';
import { RegisterDto } from './dto/register.dto';

const dto: RegisterDto = {
  email: 'alice@example.com',
  password: 'Password123',
  firstName: 'Alice',
  lastName: 'Lee',
};

// Build a fresh AuthService wired to mocked collaborators for each test.
// AuthService no longer knows Prisma exists — it talks to UsersService/RolesService.
function buildService(
  usersMock: any,
  tokensMock: any = { issueTokens: jest.fn() },
  rolesMock: any = {
    findByNameOrThrow: jest.fn().mockResolvedValue({ id: 'role-user', name: 'user' }),
  },
) {
  return Test.createTestingModule({
    providers: [
      AuthService,
      { provide: UsersService, useValue: usersMock },
      { provide: RolesService, useValue: rolesMock },
      { provide: TokensService, useValue: tokensMock },
    ],
  })
    .compile()
    .then((moduleRef) => moduleRef.get(AuthService));
}

describe('AuthService.register', () => {
  it('hashes the password and returns the user without the hash', async () => {
    const usersMock = {
      findByEmail: jest.fn().mockResolvedValue(null), // email not taken
      create: jest.fn().mockImplementation((data) =>
        Promise.resolve({
          id: 'user-1',
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }),
      ),
    };
    const service = await buildService(usersMock);

    const result = await service.register(dto);

    // Return value must NOT leak the hash.
    expect(result).not.toHaveProperty('passwordHash');
    expect(result.email).toBe(dto.email);

    // What we stored must be a hash, not the plaintext password.
    const stored = usersMock.create.mock.calls[0][0].passwordHash;
    expect(stored).toBeDefined();
    expect(stored).not.toBe(dto.password);

    // New account gets the default 'user' role.
    expect(usersMock.create.mock.calls[0][0].roleId).toBe('role-user');
  });

  it('throws ConflictException when the email is already registered', async () => {
    const usersMock = {
      findByEmail: jest.fn().mockResolvedValue({ id: 'existing', email: dto.email }),
      create: jest.fn(),
    };
    const service = await buildService(usersMock);

    await expect(service.register(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(usersMock.create).not.toHaveBeenCalled();
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
    const usersMock = { findByEmailWithRole: jest.fn().mockResolvedValue(foundUser) };
    const tokensMock = {
      issueTokens: jest.fn().mockResolvedValue({ accessToken: 'a.jwt', refreshToken: 'r-opaque' }),
    };
    const service = await buildService(usersMock, tokensMock);

    const result = await service.login(credentials);

    // Returns exactly the token pair the factory produced.
    expect(result).toEqual({ accessToken: 'a.jwt', refreshToken: 'r-opaque' });
    // The factory was handed the found user (so tokens carry the right identity/role).
    expect(tokensMock.issueTokens).toHaveBeenCalledWith(foundUser);
  });

  it('throws UnauthorizedException when the password is wrong', async () => {
    const passwordHash = await bcrypt.hash('the-real-password', 10);
    const usersMock = {
      findByEmailWithRole: jest.fn().mockResolvedValue({
        id: 'user-1',
        email: credentials.email,
        passwordHash,
        role: { name: 'user' },
      }),
    };
    const tokensMock = { issueTokens: jest.fn() };
    const service = await buildService(usersMock, tokensMock);

    await expect(service.login(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokensMock.issueTokens).not.toHaveBeenCalled(); // never issue tokens on failure
  });

  it('throws UnauthorizedException when the email is unknown', async () => {
    const usersMock = { findByEmailWithRole: jest.fn().mockResolvedValue(null) };
    const tokensMock = { issueTokens: jest.fn() };
    const service = await buildService(usersMock, tokensMock);

    await expect(service.login(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokensMock.issueTokens).not.toHaveBeenCalled();
  });
});
