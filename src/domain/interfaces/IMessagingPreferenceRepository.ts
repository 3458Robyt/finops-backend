import type { MessagingPreference, MessagingPreferenceUpdate } from '../models/MessagingPreference.js';

export interface IMessagingPreferenceRepository {
  findByUserId(userId: string): Promise<MessagingPreference | null>;
  upsert(userId: string, input: MessagingPreferenceUpdate): Promise<MessagingPreference>;
}
