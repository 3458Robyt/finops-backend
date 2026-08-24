import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';

/**
 * Dry-run first aid for credentials created before staged validation existed.
 * It never decrypts payloads and never embeds tenant or credential IDs.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = getPrismaClient();
  const rows = await prisma.cloudConnectionCredential.findMany({
    where: { purpose: 'OPERATIONAL', status: 'ACTIVE', cloudConnection: { providerCode: 'oci' } },
    select: {
      id: true,
      cloudConnectionId: true,
      label: true,
      cloudConnection: { select: { name: true, metadata: true } },
    },
  });
  const affected = rows.filter((row) => hasRejectedSignature(row.cloudConnection.metadata));
  if (apply) {
    const attemptedAt = new Date();
    await prisma.$transaction(async (tx) => {
      for (const row of affected) {
        await tx.cloudConnectionCredential.update({
          where: { id: row.id },
          data: {
            status: 'INVALID',
            validationStatus: 'REJECTED',
            validationMessage: 'Validación histórica: OCI rechazó la firma HTTP. Reemplaza la credencial con un par de clave coherente.',
            validationAttemptedAt: attemptedAt,
          },
        });
        await tx.cloudConnection.update({
          where: { id: row.cloudConnectionId },
          data: { lastValidatedAt: null, lastValidationAttemptAt: attemptedAt },
        });
      }
    });
  }

  console.log(JSON.stringify({
    success: true,
    mode: apply ? 'apply' : 'dry-run',
    inspected: rows.length,
    affected: affected.map((row) => ({ credentialId: row.id, cloudConnectionId: row.cloudConnectionId, connectionName: row.cloudConnection.name, label: row.label })),
    message: apply
      ? 'Las credenciales históricas afectadas quedaron INVALID y deben reemplazarse manualmente.'
      : 'No se modificó la base de datos. Ejecuta con --apply después de revisar la lista.',
  }, null, 2));
}

function hasRejectedSignature(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  const validation = metadata['capabilityValidation'];
  if (!isRecord(validation)) return false;
  const authentication = validation['authentication'];
  if (isRecord(authentication) && authentication['status'] === 'REJECTED') return true;
  const capabilities = validation['capabilities'];
  return Array.isArray(capabilities) && capabilities.some((item) => (
    isRecord(item)
    && item['capability'] === 'IDENTITY'
    && item['status'] === 'ERROR'
    && /signature|HTTP\(S\)/i.test(String(item['message'] ?? ''))
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Credential reconciliation failed');
  process.exit(1);
});
