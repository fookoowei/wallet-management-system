import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toSafeUser } from './to-safe-user';

export interface CreateUserData {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  roleId: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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
}
