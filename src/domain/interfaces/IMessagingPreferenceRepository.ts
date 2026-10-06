import type { MessagingPreference, MessagingPreferenceUpdate } from '../models/MessagingPreference.js';

export interface IMessagingPreferenceRepository {
  findByTenantAndUser(tenantId: string, userId: string): Promise<MessagingPreference | null>;
  upsert(tenantId: string, userId: string, input: MessagingPreferenceUpdate): Promise<MessagingPreference>;
}
