import type { NormalizedCloudResource } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { normalizeExternalResourceId } from '../../domain/models/ResourceLinkage.js';

export type PrismaCloudResourceClient = Pick<Prisma.TransactionClient, 'cloudResource'>;

export async function upsertNormalizedCloudResources(
  tx: PrismaCloudResourceClient,
  resources: readonly NormalizedCloudResource[],
): Promise<ReadonlyMap<string, string>> {
  const resourceIdsByExternalId = new Map<string, string>();
  for (const resource of resources) {
    const externalResourceId = normalizeExternalResourceId(resource.externalResourceId);
    if (externalResourceId === undefined) continue;
    const observedAt = resource.lastSeenAt ?? new Date();
    const common = resourceData(resource, externalResourceId);
    const persisted = await tx.cloudResource.upsert({
      where: { cloudConnectionId_externalResourceId: {
        cloudConnectionId: resource.cloudConnectionId,
        externalResourceId,
      } },
      update: {
        resourceType: resource.resourceType,
        serviceName: resource.serviceName,
        status: resource.status,
        lastSeenAt: observedAt,
        ...(resource.name !== undefined ? { name: resource.name } : {}),
        ...(resource.regionId !== undefined ? { regionId: resource.regionId } : {}),
        ...(resource.tags !== undefined ? { tags: resource.tags as Prisma.InputJsonValue } : {}),
        ...(resource.rawResource !== undefined ? { rawResource: resource.rawResource as Prisma.InputJsonValue } : {}),
      },
      create: {
        ...common,
        ...(resource.firstSeenAt !== undefined ? { firstSeenAt: resource.firstSeenAt } : {}),
        lastSeenAt: observedAt,
      },
      select: { id: true, externalResourceId: true },
    });
    resourceIdsByExternalId.set(persisted.externalResourceId, persisted.id);
  }
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
    ...(resource.name !== undefined ? { name: resource.name } : {}),
    ...(resource.regionId !== undefined ? { regionId: resource.regionId } : {}),
    ...(resource.tags !== undefined ? { tags: resource.tags as Prisma.InputJsonValue } : {}),
    ...(resource.rawResource !== undefined ? { rawResource: resource.rawResource as Prisma.InputJsonValue } : {}),
  };
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
}
