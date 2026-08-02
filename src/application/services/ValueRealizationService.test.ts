import { describe, expect, it } from 'vitest';
import { ValueRealizationService } from './ValueRealizationService.js';
import type { IValueRealizationRepository } from '../../domain/interfaces/IValueRealizationRepository.js';
import type { RecommendationSavingsMeasurement } from '../../domain/interfaces/IRecommendationRepository.js';
import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';

describe('ValueRealizationService', () => {
  it('reconciles candidates idempotently and notifies active tenant users only for new measurements', async () => {
    const candidate = {
      tenantId: 'tenant-1', recommendationId: 'rec-1', manualExecutionId: 'exec-1', requestedByUserId: 'user-1',
      executedAt: new Date('2026-07-01T00:00:00Z'),
    };
    const state = { measurementId: undefined as string | undefined };
    const repository = new FakeValueRepository([candidate], state);
    const recommendationRepository = new FakeRecommendationRepository(state);
    const notifications = new FakeNotificationRepository();
    const users = new FakeOutboundRepository();
    const service = new ValueRealizationService(repository, recommendationRepository as never, notifications as never, users);

    const first = await service.reconcile('tenant-1', 10);
    expect(first).toMatchObject({ attempted: 1, created: 1, unchanged: 0, calculated: 1 });
    expect(notifications.created).toHaveLength(1);

    const second = await service.reconcile('tenant-1', 10);
    expect(second).toMatchObject({ attempted: 1, created: 0, unchanged: 1 });
    expect(notifications.created).toHaveLength(1);
  });

  it('keeps a failed candidate from aborting the rest of the batch', async () => {
    const repository = new FakeValueRepository([
      { tenantId: 'tenant-1', recommendationId: 'bad', manualExecutionId: 'bad-exec', requestedByUserId: 'user-1', executedAt: new Date() },
      { tenantId: 'tenant-1', recommendationId: 'good', manualExecutionId: 'good-exec', requestedByUserId: 'user-1', executedAt: new Date() },
    ]);
    const recommendationRepository = new FakeRecommendationRepository();
    const service = new ValueRealizationService(repository, recommendationRepository as never, new FakeNotificationRepository(), new FakeOutboundRepository());
    const result = await service.reconcile('tenant-1');
    expect(result).toMatchObject({ attempted: 2, created: 1, failures: 1 });
  });
});

class FakeValueRepository implements IValueRealizationRepository {
  public constructor(candidates: readonly { tenantId: string; recommendationId: string; manualExecutionId: string; requestedByUserId: string; executedAt: Date; latestMeasurementId?: string }[], private readonly state = { measurementId: undefined as string | undefined }) { this.candidates = candidates; }
  public readonly candidates: readonly { tenantId: string; recommendationId: string; manualExecutionId: string; requestedByUserId: string; executedAt: Date; latestMeasurementId?: string }[];
  public async getSummary(): Promise<never> { throw new Error('not used'); }
  public async listItems(): Promise<never> { throw new Error('not used'); }
  public async listItemsForExport(): Promise<never> { throw new Error('not used'); }
  public async listTrend(): Promise<never> { throw new Error('not used'); }
  public async listReconciliationCandidates(): Promise<readonly typeof this.candidates[number][]> {
    return this.candidates.map((candidate) => ({ ...candidate, ...(this.state.measurementId !== undefined ? { latestMeasurementId: this.state.measurementId } : {}) }));
  }
}

class FakeRecommendationRepository {
  public constructor(private readonly state = { measurementId: undefined as string | undefined }) {}
  public async createSavingsMeasurement(input: { readonly manualExecutionId: string }): Promise<RecommendationSavingsMeasurement> {
    if (input.manualExecutionId === 'bad-exec') throw new Error('synthetic failure');
    this.state.measurementId ??= 'measurement-1';
    return {
      id: this.state.measurementId, tenantId: 'tenant-1', recommendationId: 'good', manualExecutionId: input.manualExecutionId, requestedByUserId: 'user-1',
      status: 'CALCULATED', scope: 'RESOURCE', provider: 'OCI', cloudAccountId: 'account-1', executedAt: new Date(), baselineStart: new Date(), baselineEnd: new Date(), observationStart: new Date(), observationEnd: new Date(), windowDays: 30,
      baselineCoveredDays: 30, observationCoveredDays: 30, coverageRatio: 1, billingSource: 'FOCUS', currency: 'USD', projectedMonthlySavings: 12, technicalValidationStatus: 'AVAILABLE', reasons: [], formula: {}, evidence: {}, evidenceHash: 'hash', calculationVersion: 'v1', calculationMethod: 'COST_DELTA', createdAt: new Date(), updatedAt: new Date(),
    };
  }
}

class FakeNotificationRepository implements Pick<INotificationRepository, 'create'> {
  public readonly created: unknown[] = [];
  public async create(input: unknown): Promise<never> { this.created.push(input); return undefined as never; }
}

class FakeOutboundRepository implements Pick<IOutboundMessageRepository, 'findTenantUsers'> {
  public async findTenantUsers(): Promise<readonly { id: string; email: string; name: string; status: 'ACTIVE' | 'DISABLED' }[]> { return [{ id: 'user-1', email: 'u@example.com', name: 'User', status: 'ACTIVE' }]; }
}
