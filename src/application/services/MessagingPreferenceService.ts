import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { IMessagingPreferenceRepository } from '../../domain/interfaces/IMessagingPreferenceRepository.js';
import type { MessagingPreference, MessagingPreferenceUpdate } from '../../domain/models/MessagingPreference.js';
import { requirePermission } from '../../domain/security/AuthorizationPolicy.js';

const defaults: Omit<MessagingPreference, 'id' | 'userId' | 'createdAt' | 'updatedAt'> = {
  emailEnabled: true,
  telegramEnabled: false,
  operationalAlerts: true,
  recommendationAlerts: true,
  financialAlerts: true,
  executiveSummaries: true,
};

export class MessagingPreferenceService {
  constructor(private readonly repository: IMessagingPreferenceRepository) {}

  public async get(actor: AuthContext): Promise<MessagingPreference> {
    requirePermission(actor.role, 'FINOPS_READ');
    const current = await this.repository.findByUserId(actor.userId);
    if (current !== null) return current;
    const now = new Date();
    return { id: 'virtual-default', userId: actor.userId, ...defaults, createdAt: now, updatedAt: now };
  }

  public async update(actor: AuthContext, input: MessagingPreferenceUpdate): Promise<MessagingPreference> {
    requirePermission(actor.role, 'FINOPS_READ');
    return this.repository.upsert(actor.userId, input);
  }

  public async allows(userId: string, channel: 'EMAIL' | 'TELEGRAM', category: keyof typeof categoryToPreference): Promise<boolean> {
    const preference = await this.repository.findByUserId(userId);
    const current = preference ?? defaults;
    if (channel === 'EMAIL' && !current.emailEnabled) return false;
    if (channel === 'TELEGRAM' && !current.telegramEnabled) return false;
    return current[categoryToPreference[category]];
  }
}

const categoryToPreference = {
  operational: 'operationalAlerts',
  recommendations: 'recommendationAlerts',
  financial: 'financialAlerts',
  executive: 'executiveSummaries',
} as const;
