import type {
  IResourceLinkageReadinessRepository,
  ResourceLinkageReadiness,
} from '../../domain/interfaces/IResourceLinkageReadinessRepository.js';
import { buildDeterministicOpportunityCatalog } from './finops/deterministicOpportunityCatalog.js';

export class ResourceLinkageReadinessService {
  public constructor(private readonly repository: IResourceLinkageReadinessRepository) {}

  public async getForTenant(tenantId: string, limit?: number): Promise<ResourceLinkageReadiness> {
    const resourceLimit = Number.isInteger(limit) && limit !== undefined
      ? Math.min(Math.max(limit, 1), 200)
      : 50;
    const readiness = await this.repository.getForTenant(tenantId, resourceLimit);
    return {
      ...readiness,
      opportunityCatalog: buildDeterministicOpportunityCatalog(readiness),
    };
  }
}
