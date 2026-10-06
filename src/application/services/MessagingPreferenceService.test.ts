import { describe, expect, it } from 'vitest';
import type { IMessagingPreferenceRepository } from '../../domain/interfaces/IMessagingPreferenceRepository.js';
import type { MessagingPreference, MessagingPreferenceUpdate } from '../../domain/models/MessagingPreference.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import { MessagingPreferenceService } from './MessagingPreferenceService.js';

describe('MessagingPreferenceService', () => {
  it('returns safe defaults before a user has saved preferences', async () => {
    const repository = new PreferenceRepositoryFake();
    const preferences = await new MessagingPreferenceService(repository).get(actor());

    expect(preferences).toMatchObject({
      tenantId: 'tenant-1',
      userId: 'user-1',
      emailEnabled: true,
      telegramEnabled: false,
      operationalAlerts: true,
      recommendationAlerts: true,
      financialAlerts: true,
      executiveSummaries: true,
    });
    expect(repository.upsertCalls).toHaveLength(0);
  });

  it('persists channel/category changes and applies them to delivery decisions', async () => {
    const repository = new PreferenceRepositoryFake();
    const service = new MessagingPreferenceService(repository);

    await service.update(actor(), { telegramEnabled: true, financialAlerts: false });
    await service.update(actor('tenant-2'), { telegramEnabled: true, financialAlerts: true });

    await expect(service.allows('tenant-1', 'user-1', 'TELEGRAM', 'financial')).resolves.toBe(false);
    await expect(service.allows('tenant-1', 'user-1', 'TELEGRAM', 'recommendations')).resolves.toBe(true);
    await expect(service.allows('tenant-2', 'user-1', 'TELEGRAM', 'financial')).resolves.toBe(true);
    expect(repository.upsertCalls).toEqual([
      { tenantId: 'tenant-1', userId: 'user-1', input: { telegramEnabled: true, financialAlerts: false } },
      { tenantId: 'tenant-2', userId: 'user-1', input: { telegramEnabled: true, financialAlerts: true } },
    ]);
  });
});

class PreferenceRepositoryFake implements IMessagingPreferenceRepository {
  private readonly current = new Map<string, MessagingPreference>();
  public readonly upsertCalls: { readonly tenantId: string; readonly userId: string; readonly input: MessagingPreferenceUpdate }[] = [];

  public async findByTenantAndUser(tenantId: string, userId: string): Promise<MessagingPreference | null> {
    return this.current.get(`${tenantId}:${userId}`) ?? null;
  }

  public async upsert(tenantId: string, userId: string, input: MessagingPreferenceUpdate): Promise<MessagingPreference> {
    this.upsertCalls.push({ tenantId, userId, input });
    const now = new Date('2026-08-31T00:00:00.000Z');
    const key = `${tenantId}:${userId}`;
    const previous = this.current.get(key);
    const saved = {
      id: 'preference-1',
      tenantId,
      userId,
      emailEnabled: previous?.emailEnabled ?? true,
      telegramEnabled: previous?.telegramEnabled ?? false,
      operationalAlerts: previous?.operationalAlerts ?? true,
      recommendationAlerts: previous?.recommendationAlerts ?? true,
      financialAlerts: previous?.financialAlerts ?? true,
      executiveSummaries: previous?.executiveSummaries ?? true,
      ...input,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.current.set(key, saved);
    return saved;
  }
}

function actor(tenantId = 'tenant-1'): AuthContext {
  return {
    userId: 'user-1',
    tenantId,
    email: 'user@example.test',
    role: 'FINOPS_TECHNICIAN',
    jwtId: 'jwt-1',
  };
}
