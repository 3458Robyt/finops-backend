import type {
  OutboundMessageChannel,
  OutboundMessageDelivery,
  OutboundMessageStatus,
  OutboundMessageType,
} from '../models/OutboundMessage.js';

export interface CreateOutboundMessageDeliveryInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly recommendationId?: string;
  readonly channel: OutboundMessageChannel;
  readonly messageType: OutboundMessageType;
  readonly status?: OutboundMessageStatus;
  readonly subject?: string;
  readonly preview: string;
  readonly providerMessageId?: string;
  readonly errorMessage?: string;
  readonly metadata?: unknown;
  readonly sentAt?: Date;
}

export interface ListOutboundMessageDeliveriesInput {
  readonly tenantId: string;
  readonly limit: number;
}

export interface IOutboundMessageRepository {
  create(input: CreateOutboundMessageDeliveryInput): Promise<OutboundMessageDelivery>;
  listRecent(input: ListOutboundMessageDeliveriesInput): Promise<readonly OutboundMessageDelivery[]>;
  findTenantUsers(tenantId: string): Promise<readonly { readonly id: string; readonly email: string; readonly name: string; readonly status: 'ACTIVE' | 'DISABLED' }[]>;
}
