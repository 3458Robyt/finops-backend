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

    await expect(service.allows('user-1', 'TELEGRAM', 'financial')).resolves.toBe(false);
    await expect(service.allows('user-1', 'TELEGRAM', 'recommendations')).resolves.toBe(true);
    expect(repository.upsertCalls).toEqual([{ userId: 'user-1', input: { telegramEnabled: true, financialAlerts: false } }]);
  });
});

class PreferenceRepositoryFake implements IMessagingPreferenceRepository {
  private current: MessagingPreference | null = null;
  public readonly upsertCalls: { readonly userId: string; readonly input: MessagingPreferenceUpdate }[] = [];

  public async findByUserId(_userId: string): Promise<MessagingPreference | null> {
    return this.current;
  }

  public async upsert(userId: string, input: MessagingPreferenceUpdate): Promise<MessagingPreference> {
    this.upsertCalls.push({ userId, input });
    const now = new Date('2026-08-31T00:00:00.000Z');
    this.current = {
      id: 'preference-1',
      userId,
      emailEnabled: this.current?.emailEnabled ?? true,
      telegramEnabled: this.current?.telegramEnabled ?? false,
      operationalAlerts: this.current?.operationalAlerts ?? true,
      recommendationAlerts: this.current?.recommendationAlerts ?? true,
      financialAlerts: this.current?.financialAlerts ?? true,
      executiveSummaries: this.current?.executiveSummaries ?? true,
      ...input,
      createdAt: this.current?.createdAt ?? now,
      updatedAt: now,
    };
    return this.current;
  }
}

function actor(): AuthContext {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    email: 'user@example.test',
    role: 'FINOPS_TECHNICIAN',
    jwtId: 'jwt-1',
  };
}
