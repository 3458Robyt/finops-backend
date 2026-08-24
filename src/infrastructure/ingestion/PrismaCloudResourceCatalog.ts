import type { NormalizedCloudResource } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { normalizeExternalResourceId } from '../../domain/models/ResourceLinkage.js';

export type PrismaCloudResourceClient = Pick<Prisma.TransactionClient, 'cloudResource'>;

export async function upsertNormalizedCloudResources(
  tx: PrismaCloudResourceClient,
  resources: readonly NormalizedCloudResource[],
): Promise<ReadonlyMap<string, string>> {
  const resourceIdsByExternalId = new Map<string, string>();
  await mapWithConcurrency(resources, 8, async (resource) => {
    const externalResourceId = normalizeExternalResourceId(resource.externalResourceId);
    if (externalResourceId === undefined) return;
    const observedAt = resource.lastSeenAt ?? new Date();
    const identity = resolveIdentityMetadata(resource);
    const where = {
      cloudConnectionId_externalResourceId: {
        cloudConnectionId: resource.cloudConnectionId,
        externalResourceId,
      },
    } as const;
    const existing = await tx.cloudResource.findUnique({
      where,
      select: { id: true, externalResourceId: true, identityPriority: true, lastSeenAt: true },
    });
    const persisted = existing === null
      ? await tx.cloudResource.create({
          data: {
            ...resourceData(resource, externalResourceId),
            identitySource: identity.source,
            identityPriority: identity.priority,
            ...(resource.firstSeenAt !== undefined ? { firstSeenAt: resource.firstSeenAt } : {}),
            lastSeenAt: observedAt,
          },
          select: { id: true, externalResourceId: true },
        })
      : await tx.cloudResource.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: existing.lastSeenAt > observedAt ? existing.lastSeenAt : observedAt,
            ...(identity.priority >= existing.identityPriority
              ? {
                  identitySource: identity.source,
                  identityPriority: identity.priority,
                  resourceType: resource.resourceType,
                  serviceName: resource.serviceName,
                  status: resource.status,
                  ...(resource.name !== undefined ? { name: resource.name } : {}),
                  ...(resource.regionId !== undefined ? { regionId: resource.regionId } : {}),
                  ...(resource.tags !== undefined ? { tags: resource.tags as Prisma.InputJsonValue } : {}),
                  ...(resource.rawResource !== undefined ? { rawResource: resource.rawResource as Prisma.InputJsonValue } : {}),
                }
              : {}),
          },
          select: { id: true, externalResourceId: true },
        });
    resourceIdsByExternalId.set(persisted.externalResourceId, persisted.id);
  });
  return resourceIdsByExternalId;
}

export async function insertHistoricalCloudResources(
  tx: PrismaCloudResourceClient,
  resources: readonly NormalizedCloudResource[],
): Promise<number> {
  let inserted = 0;
  for (const batch of chunk(resources, 500)) {
    const data = batch.flatMap((resource): Prisma.CloudResourceCreateManyInput[] => {
      const externalResourceId = normalizeExternalResourceId(resource.externalResourceId);
      if (externalResourceId === undefined) return [];
      const observedAt = resource.lastSeenAt ?? new Date();
      return [{
        ...resourceData(resource, externalResourceId),
        firstSeenAt: resource.firstSeenAt ?? observedAt,
        lastSeenAt: observedAt,
      }];
    });
    if (data.length === 0) continue;
    inserted += (await tx.cloudResource.createMany({ data, skipDuplicates: true })).count;
  }
  return inserted;
}

function resourceData(
  resource: NormalizedCloudResource,
  externalResourceId: string,
): Prisma.CloudResourceUncheckedCreateInput {
  return {
    tenantId: resource.tenantId,
    cloudConnectionId: resource.cloudConnectionId,
    provider: resource.provider,
    externalResourceId,
    resourceType: resource.resourceType,
    serviceName: resource.serviceName,
    status: resource.status,
    identitySource: resolveIdentityMetadata(resource).source,
    identityPriority: resolveIdentityMetadata(resource).priority,
    ...(resource.name !== undefined ? { name: resource.name } : {}),
    ...(resource.regionId !== undefined ? { regionId: resource.regionId } : {}),
    ...(resource.tags !== undefined ? { tags: resource.tags as Prisma.InputJsonValue } : {}),
    ...(resource.rawResource !== undefined ? { rawResource: resource.rawResource as Prisma.InputJsonValue } : {}),
  };
}

function resolveIdentityMetadata(resource: NormalizedCloudResource): { readonly source: string; readonly priority: number } {
  const source = resource.identitySource
    ?? (typeof resource.rawResource?.['source'] === 'string' ? resource.rawResource['source'] : undefined)
    ?? 'UNKNOWN';
  const priority = resource.identityPriority ?? sourcePriority(source);
  return { source, priority };
}

function sourcePriority(source: string): number {
  switch (source) {
    case 'OCI_INVENTORY_METADATA':
    case 'AWS_INVENTORY_METADATA':
      return 4;
    case 'OCI_COMPUTE_SDK':
    case 'AWS_EC2_SDK':
      return 3;
    case 'OCI_RESOURCE_SEARCH':
      return 2;
    case 'OCI_METRIC_DEFINITION':
    case 'AWS_METRIC_DEFINITION':
      return 1;
    default:
      return 0;
  }
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await mapper(values[index]!);
    }
  }));
}
