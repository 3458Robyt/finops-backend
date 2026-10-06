import type { PrismaClient } from '../../generated/prisma/client.js';
import type { IMessagingPreferenceRepository } from '../../domain/interfaces/IMessagingPreferenceRepository.js';
import type { MessagingPreference, MessagingPreferenceUpdate } from '../../domain/models/MessagingPreference.js';

export class PrismaMessagingPreferenceRepository implements IMessagingPreferenceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findByTenantAndUser(tenantId: string, userId: string): Promise<MessagingPreference | null> {
    const row = await this.prisma.userMessagingPreference.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
    return row === null ? null : toMessagingPreference(row);
  }

  public async upsert(tenantId: string, userId: string, input: MessagingPreferenceUpdate): Promise<MessagingPreference> {
    const row = await this.prisma.userMessagingPreference.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, ...input },
      update: input,
    });
    return toMessagingPreference(row);
  }
}

function toMessagingPreference(row: {
  readonly id: string;
  readonly tenantId: string;
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
