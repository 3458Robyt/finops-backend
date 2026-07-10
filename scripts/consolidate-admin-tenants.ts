import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import type { TenantAccessRole, UserRole } from '../src/generated/prisma/enums.js';

interface Args {
  readonly canonicalEmail: string;
  readonly duplicateEmails: readonly string[];
  readonly apply: boolean;
}

const adminRoles = new Set<UserRole>(['ADMIN', 'MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN']);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = getPrismaClient();

  const canonical = await prisma.user.findUnique({
    where: { email: args.canonicalEmail },
    select: { id: true, email: true, tenantId: true, role: true, status: true },
  });

  if (canonical === null) {
    throw new Error(`Canonical user not found: ${args.canonicalEmail}`);
  }

  if (!adminRoles.has(canonical.role)) {
    throw new Error(`Canonical user must be an admin/operator role. Current role: ${canonical.role}`);
  }

  const duplicates = await prisma.user.findMany({
    where: { email: { in: [...args.duplicateEmails] } },
    select: { id: true, email: true, tenantId: true, role: true, status: true },
  });

  const foundDuplicateEmails = new Set(duplicates.map((user) => user.email));
  for (const email of args.duplicateEmails) {
    if (!foundDuplicateEmails.has(email)) {
      throw new Error(`Duplicate user not found: ${email}`);
    }
  }

  const targetTenantIds = new Set<string>([canonical.tenantId]);
  for (const duplicate of duplicates) {
    targetTenantIds.add(duplicate.tenantId);
  }

  const assignments = await prisma.tenantAccessAssignment.findMany({
    where: { userId: { in: duplicates.map((user) => user.id) }, disabledAt: null },
    select: { tenantId: true, role: true },
  });

  const assignmentRoleByTenant = new Map<string, TenantAccessRole>();
  for (const tenantId of targetTenantIds) {
    assignmentRoleByTenant.set(tenantId, 'OPERATOR_ADMIN');
  }

  for (const assignment of assignments) {
    assignmentRoleByTenant.set(assignment.tenantId, assignment.role);
  }

  console.log(JSON.stringify({
    mode: args.apply ? 'apply' : 'dry-run',
    canonical: canonical.email,
    duplicateEmails: duplicates.map((user) => user.email),
    tenantAssignmentsToEnsure: [...assignmentRoleByTenant.entries()].map(([tenantId, role]) => ({ tenantId, role })),
    duplicateUsersToDisable: duplicates.map((user) => ({ id: user.id, email: user.email, status: user.status })),
  }, null, 2));

  if (!args.apply) {
    console.log('Dry-run only. Re-run with --apply to persist changes.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const [tenantId, role] of assignmentRoleByTenant) {
      await tx.tenantAccessAssignment.upsert({
        where: {
          tenantId_userId: {
            tenantId,
            userId: canonical.id,
          },
        },
        update: {
          role,
          disabledAt: null,
        },
        create: {
          tenantId,
          userId: canonical.id,
          role,
        },
      });
    }

    if (duplicates.length > 0) {
      await tx.user.updateMany({
        where: { id: { in: duplicates.map((user) => user.id) } },
        data: { status: 'DISABLED' },
      });
    }
  });

  console.log('Consolidation complete.');
}

function parseArgs(rawArgs: readonly string[]): Args {
  const values = new Map<string, string>();
  let apply = false;

  for (const arg of rawArgs) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }

    const [key, value] = arg.split('=', 2);
    if (key !== undefined && value !== undefined && key.startsWith('--')) {
      values.set(key.slice(2), value);
    }
  }

  const canonicalEmail = values.get('canonical-email')?.trim().toLowerCase();
  if (canonicalEmail === undefined || canonicalEmail === '') {
    throw new Error('Usage: npm run users:consolidate-admin-tenants -- --canonical-email=admin@example.com --duplicate-emails=a@x.com,b@x.com [--apply]');
  }

  const duplicateEmails = values.get('duplicate-emails')
    ?.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== '') ?? [];

  if (duplicateEmails.length === 0) {
    throw new Error('At least one duplicate email is required via --duplicate-emails=email1,email2');
  }

  if (duplicateEmails.includes(canonicalEmail)) {
    throw new Error('Canonical email cannot be included in duplicate emails.');
  }

  return { canonicalEmail, duplicateEmails, apply };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
