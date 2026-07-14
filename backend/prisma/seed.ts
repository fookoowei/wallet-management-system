import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const PERMISSIONS = [
  'deposit.approve',
  'withdrawal.approve',
  'wallet.adjust',
  'user.manage',
  'audit.view',
  'transaction.view_all',
];

const ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: PERMISSIONS, // all
  admin: ['user.manage', 'transaction.view_all', 'audit.view'],
  finance: ['deposit.approve', 'withdrawal.approve', 'wallet.adjust', 'transaction.view_all'],
  support: ['transaction.view_all'],
  user: [],
};

async function main() {
  // 1. permissions
  for (const code of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code },
    });
  }

  // 2. roles with their permissions
  for (const [name, codes] of Object.entries(ROLE_PERMISSIONS)) {
    await prisma.role.upsert({
      where: { name },
      update: {
        permissions: { set: codes.map((code) => ({ code })) },
      },
      create: {
        name,
        permissions: { connect: codes.map((code) => ({ code })) },
      },
    });
  }

  // 3. super-admin user
  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'super_admin' } });
  const passwordHash = await bcrypt.hash('ChangeMe123!', 10);
  await prisma.user.upsert({
    where: { email: 'admin@wallet.local' },
    update: {},
    create: {
      email: 'admin@wallet.local',
      passwordHash,
      firstName: 'Super',
      lastName: 'Admin',
      roleId: superAdminRole.id,
    },
  });

  console.log('Seed complete: permissions, roles, super-admin user.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
