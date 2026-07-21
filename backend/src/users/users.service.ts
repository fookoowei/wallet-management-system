import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RolesService } from './roles.service';
import { toSafeUser } from './to-safe-user';
import type { AuthUser } from '../auth/jwt.strategy';

export interface CreateUserData {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  roleId: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
  ) {}

  create(data: CreateUserData) {
    return this.prisma.user.create({ data });
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByEmailWithRole(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      include: { role: true },
    });
  }

  /**
   * The guard's lookup: the whole authorisation picture in one query.
   * Returns the RAW row (hash included) — only PermissionsGuard consumes it and its
   * result never reaches a response, so it is deliberately not passed through toSafeUser.
   */
  findByIdWithPermissions(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: { role: { include: { permissions: true } } },
    });
  }

  /** One page of users, plus the total so a UI can render "showing 10–20 of 37". */
  async findMany({ skip = 0, take = 20 }: { skip?: number; take?: number }) {
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: { role: { select: { id: true, name: true } } },
      }),
      this.prisma.user.count(),
    ]);
    return { total, skip, take, users: users.map(toSafeUser) };
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { role: { select: { id: true, name: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return toSafeUser(user);
  }

  async updateStatus(id: string, status: 'active' | 'suspended', actor: AuthUser) {
    // Self-lockout guard: suspending yourself is never intentional.
    if (id === actor.id) throw new ForbiddenException('You cannot change your own status');

    await this.findById(id); // 404 if the target doesn't exist
    const user = await this.prisma.user.update({
      where: { id },
      data: { status },
      include: { role: { select: { id: true, name: true } } },
    });
    return toSafeUser(user);
  }

  async updateRole(id: string, roleName: string, actor: AuthUser) {
    // Self-escalation guard. `user.manage` belongs to `admin`; without this rule an
    // admin could promote themselves to super_admin and inherit every permission in
    // the system — including withdrawal.approve, deliberately withheld from them.
    if (id === actor.id) throw new ForbiddenException('You cannot change your own role');

    // ...and blocking self-promotion is pointless if an admin can crown an accomplice.
    if (roleName === 'super_admin' && actor.role !== 'super_admin') {
      throw new ForbiddenException('Only a super_admin may assign the super_admin role');
    }

    const role = await this.roles.findByName(roleName);
    if (!role) throw new NotFoundException(`Unknown role: ${roleName}`);

    await this.findById(id); // 404 if the target doesn't exist
    const user = await this.prisma.user.update({
      where: { id },
      data: { roleId: role.id },
      include: { role: { select: { id: true, name: true } } },
    });
    return toSafeUser(user);
  }
}
