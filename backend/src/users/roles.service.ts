import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  findByName(name: string) {
    return this.prisma.role.findUnique({ where: { name } });
  }

  /** Throws if absent. Used where a missing role means the seed is broken, not bad input. */
  findByNameOrThrow(name: string) {
    return this.prisma.role.findUniqueOrThrow({ where: { name } });
  }

  findAll() {
    return this.prisma.role.findMany({
      select: { id: true, name: true, description: true },
      orderBy: { name: 'asc' },
    });
  }
}
