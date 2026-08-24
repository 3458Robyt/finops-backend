import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { CredentialCipher } from '../src/infrastructure/security/CredentialCipher.js';
import { inspectOciPrivateKey } from '../src/application/services/cloud-connections/ociPrivateKey.js';

/**
 * Derives non-secret OCI key identities for credentials created before the
 * idempotency migration. Dry-run is the default; --apply writes only the
 * derived fingerprint and never logs decrypted material.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = getPrismaClient();
  const cipher = new CredentialCipher(process.env.CREDENTIAL_ENCRYPTION_KEY, process.env.CREDENTIAL_KEY_VERSION ?? 'v1');
  const rows = await prisma.cloudConnectionCredential.findMany({
    where: { keyFingerprint: null, cloudConnection: { providerCode: 'oci' } },
    select: {
      id: true,
      encryptedPayload: true,
      encryptionIv: true,
      encryptionAuthTag: true,
      encryptionAlgorithm: true,
      encryptionKeyVersion: true,
    },
  });

  let derived = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const payload = cipher.decrypt(row);
      if (typeof payload['privateKey'] !== 'string') {
        skipped += 1;
        continue;
      }
      const inspection = inspectOciPrivateKey(
        payload['privateKey'],
        typeof payload['passphrase'] === 'string' ? payload['passphrase'] : undefined,
      );
      derived += 1;
      if (apply) {
        await prisma.cloudConnectionCredential.update({
          where: { id: row.id },
          data: { keyFingerprint: inspection.fingerprint },
        });
      }
    } catch {
      skipped += 1;
    }
  }

  console.log(JSON.stringify({
    success: true,
    mode: apply ? 'apply' : 'dry-run',
    inspected: rows.length,
    derived,
    skipped,
    message: apply
      ? 'Fingerprints no sensibles actualizados; no se imprimieron claves ni passphrases.'
      : 'Dry-run: no se modificó la base de datos. Ejecuta con --apply después de revisar los conteos.',
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Credential fingerprint reconciliation failed');
  process.exit(1);
});
