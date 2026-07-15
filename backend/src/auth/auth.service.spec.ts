import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';

const dto: RegisterDto = {
  email: 'alice@example.com',
  password: 'Password123',
  firstName: 'Alice',
  lastName: 'Lee',
};

// Build a fresh AuthService wired to a mocked PrismaService for each test.
function buildService(prismaMock: any) {
  return Test.createTestingModule({
    providers: [AuthService, { provide: PrismaService, useValue: prismaMock }],
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
