import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationNamePattern = /^\d{12}_[a-z0-9_]+$/;

export function latestMigrationId(repositoryRoot = process.cwd()): string {
  const migrations = readdirSync(resolve(repositoryRoot, 'prisma', 'migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && migrationNamePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const latest = migrations.at(-1);
  if (latest === undefined) throw new Error('No Prisma migration directory was found.');
  return latest;
}
