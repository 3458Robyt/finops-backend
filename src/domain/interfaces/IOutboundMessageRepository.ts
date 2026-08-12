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
  readonly body?: string;
  readonly providerMessageId?: string;
  readonly errorMessage?: string;
  readonly metadata?: unknown;
  readonly sentAt?: Date;
  readonly maxAttempts?: number;
}

export interface ListOutboundMessageDeliveriesInput {
  readonly tenantId: string;
  readonly limit: number;
}

export interface ClaimOutboundMessageDeliveryInput {
  readonly workerId: string;
  readonly leaseExpiredBefore: Date;
}

export interface ClaimedOutboundMessageDelivery {
  readonly delivery: OutboundMessageDelivery;
  readonly body: string;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface CompleteOutboundMessageDeliveryInput {
  readonly id: string;
  readonly workerId: string;
  readonly status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
  readonly errorMessage?: string;
  readonly providerMessageId?: string;
  readonly nextAttemptAt?: Date;
}

export interface IOutboundMessageRepository {
  create(input: CreateOutboundMessageDeliveryInput): Promise<OutboundMessageDelivery>;
  listRecent(input: ListOutboundMessageDeliveriesInput): Promise<readonly OutboundMessageDelivery[]>;
  claimNextPending(input: ClaimOutboundMessageDeliveryInput): Promise<ClaimedOutboundMessageDelivery | null>;
  completeClaimed(input: CompleteOutboundMessageDeliveryInput): Promise<OutboundMessageDelivery | null>;
  findTenantUsers(tenantId: string): Promise<readonly { readonly id: string; readonly email: string; readonly name: string; readonly status: 'ACTIVE' | 'DISABLED' }[]>;
}
