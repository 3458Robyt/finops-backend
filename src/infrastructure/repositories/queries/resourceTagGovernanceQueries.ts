import { buildTagGovernance } from '../../../application/services/finops/tagGovernance.js';
import type { ResourceTagGovernance } from '../../../domain/interfaces/IResourceLinkageReadinessRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { Prisma } from '../../../generated/prisma/client.js';

interface TagGovernanceSummaryRow {
  readonly total_resources: bigint;
  readonly tagged_resources: bigint;
  readonly compliant_resources: bigint;
}

interface MissingTagRow {
  readonly key: string;
  readonly count: bigint;
}

export const DEFAULT_REQUIRED_TAG_KEYS = ['environment', 'owner', 'application', 'cost_center'] as const;

export async function queryResourceTagGovernance(
  prisma: PrismaClient,
  tenantId: string,
  configuredKeys: readonly string[] = DEFAULT_REQUIRED_TAG_KEYS,
): Promise<ResourceTagGovernance> {
  const requiredKeys = normalizeRequiredTagKeys(configuredKeys);
  if (requiredKeys.length === 0) {
    return buildTagGovernance([], {
      totalResources: await prisma.cloudResource.count({ where: { tenantId } }),
      taggedResources: 0,
      compliantResources: 0,
      missingKeys: {},
    });
  }

  const keys = Prisma.join(requiredKeys.map((key) => Prisma.sql`${key}`));
  const [summaryRows, missingRows] = await Promise.all([
    prisma.$queryRaw<TagGovernanceSummaryRow[]>(Prisma.sql`
      SELECT
        count(*)::bigint AS total_resources,
        count(*) FILTER (
          WHERE jsonb_typeof(COALESCE(tags, '{}'::jsonb)) = 'object'
            AND COALESCE(tags, '{}'::jsonb) <> '{}'::jsonb
        )::bigint AS tagged_resources,
        count(*) FILTER (
          WHERE NOT EXISTS (
            SELECT 1 FROM unnest(ARRAY[${keys}]::text[]) AS required(key)
            WHERE btrim(COALESCE(tags ->> required.key, '')) = ''
          )
        )::bigint AS compliant_resources
      FROM cloud_resources WHERE tenant_id = ${tenantId}
    `),
    prisma.$queryRaw<MissingTagRow[]>(Prisma.sql`
      SELECT required.key, count(*)::bigint AS count
      FROM cloud_resources
      CROSS JOIN unnest(ARRAY[${keys}]::text[]) AS required(key)
      WHERE tenant_id = ${tenantId}
        AND btrim(COALESCE(tags ->> required.key, '')) = ''
      GROUP BY required.key
    `),
  ]);

  const summary = summaryRows[0];
  return buildTagGovernance(requiredKeys, {
    totalResources: Number(summary?.total_resources ?? 0n),
    taggedResources: Number(summary?.tagged_resources ?? 0n),
    compliantResources: Number(summary?.compliant_resources ?? 0n),
    missingKeys: Object.fromEntries(missingRows.map((row) => [row.key, Number(row.count)])),
  });
}

function normalizeRequiredTagKeys(configured: readonly string[]): readonly string[] {
  const normalized = configured
    .map((key) => key.trim())
    .filter((key) => key.length > 0 && key.length <= 128);
  return [...new Set(normalized)].slice(0, 20);
}
