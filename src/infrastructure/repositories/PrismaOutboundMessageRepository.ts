import type {
  CreateOutboundMessageDeliveryInput,
  IOutboundMessageRepository,
  ListOutboundMessageDeliveriesInput,
} from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { OutboundMessageDelivery } from '../../domain/models/OutboundMessage.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

export class PrismaOutboundMessageRepository implements IOutboundMessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async create(input: CreateOutboundMessageDeliveryInput): Promise<OutboundMessageDelivery> {
    const row = await this.prisma.outboundMessageDelivery.create({
      data: {
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.recommendationId !== undefined ? { recommendationId: input.recommendationId } : {}),
        channel: input.channel,
        messageType: input.messageType,
        status: input.status ?? 'PENDING',
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        preview: input.preview,
        ...(input.providerMessageId !== undefined ? { providerMessageId: input.providerMessageId } : {}),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
      },
    });

    return toOutboundDelivery(row);
  }

  public async listRecent(input: ListOutboundMessageDeliveriesInput): Promise<readonly OutboundMessageDelivery[]> {
    const rows = await this.prisma.outboundMessageDelivery.findMany({
      where: { tenantId: input.tenantId },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(input.limit, 100)),
    });

    return rows.map(toOutboundDelivery);
  }

  public async findTenantUsers(tenantId: string): Promise<readonly { readonly id: string; readonly email: string; readonly name: string; readonly status: 'ACTIVE' | 'DISABLED' }[]> {
    return this.prisma.user.findMany({
      where: { tenantId },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
      },
      orderBy: { email: 'asc' },
    });
  }
}

function toOutboundDelivery(row: {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly recommendationId: string | null;
  readonly channel: OutboundMessageDelivery['channel'];
  readonly messageType: OutboundMessageDelivery['messageType'];
  readonly status: OutboundMessageDelivery['status'];
  readonly subject: string | null;
  readonly preview: string;
  readonly providerMessageId: string | null;
  readonly errorMessage: string | null;
  readonly metadata: unknown;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): OutboundMessageDelivery {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ...(row.userId !== null ? { userId: row.userId } : {}),
    ...(row.recommendationId !== null ? { recommendationId: row.recommendationId } : {}),
    channel: row.channel,
    messageType: row.messageType,
    status: row.status,
    ...(row.subject !== null ? { subject: row.subject } : {}),
    preview: row.preview,
    ...(row.providerMessageId !== null ? { providerMessageId: row.providerMessageId } : {}),
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    ...(row.sentAt !== null ? { sentAt: row.sentAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
