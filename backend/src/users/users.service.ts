import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
}
