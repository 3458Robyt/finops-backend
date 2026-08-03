import type {
  IResourceLinkageReadinessRepository,
  ResourceLinkageReadiness,
} from '../../domain/interfaces/IResourceLinkageReadinessRepository.js';

export class ResourceLinkageReadinessService {
  public constructor(private readonly repository: IResourceLinkageReadinessRepository) {}

  public getForTenant(tenantId: string, limit?: number): Promise<ResourceLinkageReadiness> {
    const resourceLimit = Number.isInteger(limit) && limit !== undefined
      ? Math.min(Math.max(limit, 1), 200)
      : 50;
    return this.repository.getForTenant(tenantId, resourceLimit);
  }
}
