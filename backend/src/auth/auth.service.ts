import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from './tokens.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

// Precomputed once at startup. When an email doesn't exist we still run one
// bcrypt.compare against this dummy hash, so login takes ~constant time and
// can't be used as a timing oracle to discover which emails have accounts.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('a-non-matching-dummy-password', 10);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');

    const role = await this.prisma.role.findUniqueOrThrow({ where: { name: 'user' } });
    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        roleId: role.id,
      },
    });

    const { passwordHash: _passwordHash, ...safeUser } = user;
    return safeUser;
  }

  async login(dto: LoginDto) {
    // Look up by email, pulling in the role so the token can carry role.name.
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { role: true },
    });

    // Same vague failure for "no such email" AND "wrong password" — this denies
    // an attacker any signal about which emails have accounts (user enumeration).
    // Always run one bcrypt.compare (dummy hash if no user) to keep timing constant.
    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !passwordMatches) throw new UnauthorizedException('Invalid credentials');

    return this.tokens.issueTokens(user);
  }
}
