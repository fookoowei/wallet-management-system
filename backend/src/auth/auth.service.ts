import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { RolesService } from '../users/roles.service';
import { toSafeUser } from '../users/to-safe-user';
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
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly tokens: TokensService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) throw new ConflictException('Email already registered');

    const role = await this.roles.findByNameOrThrow('user');
    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.users.create({
      email: dto.email,
      passwordHash,
      firstName: dto.firstName,
      lastName: dto.lastName,
      roleId: role.id,
    });

    return toSafeUser(user);
  }

  async login(dto: LoginDto) {
    const user = await this.users.findByEmailWithRole(dto.email);

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
