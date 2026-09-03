import type { PrismaClient } from '../../generated/prisma/client.js';
import type { IMessagingPreferenceRepository } from '../../domain/interfaces/IMessagingPreferenceRepository.js';
import type { MessagingPreference, MessagingPreferenceUpdate } from '../../domain/models/MessagingPreference.js';

export class PrismaMessagingPreferenceRepository implements IMessagingPreferenceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findByUserId(userId: string): Promise<MessagingPreference | null> {
    const row = await this.prisma.userMessagingPreference.findUnique({ where: { userId } });
    return row === null ? null : toMessagingPreference(row);
  }

  public async upsert(userId: string, input: MessagingPreferenceUpdate): Promise<MessagingPreference> {
    const row = await this.prisma.userMessagingPreference.upsert({
      where: { userId },
      create: { userId, ...input },
      update: input,
    });
    return toMessagingPreference(row);
  }
}

function toMessagingPreference(row: {
  readonly id: string;
  readonly userId: string;
  readonly emailEnabled: boolean;
  readonly telegramEnabled: boolean;
  readonly operationalAlerts: boolean;
  readonly recommendationAlerts: boolean;
  readonly financialAlerts: boolean;
  readonly executiveSummaries: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): MessagingPreference {
  return { ...row };
}
