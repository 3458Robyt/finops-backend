export type OutboundMessageChannel = 'TELEGRAM' | 'EMAIL';

export type OutboundMessageType =
  | 'TEST'
  | 'SAVINGS_REMINDER'
  | 'AI_CHAT_RESPONSE'
  | 'RECOMMENDATION_SUMMARY'
  | 'EXECUTION_PLAN_READY'
  | 'BUDGET_ALERT';

export type OutboundMessageStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface OutboundMessageDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly userId?: string;
  readonly recommendationId?: string;
  readonly channel: OutboundMessageChannel;
  readonly messageType: OutboundMessageType;
  readonly status: OutboundMessageStatus;
  readonly subject?: string;
  readonly preview: string;
  readonly providerMessageId?: string;
  readonly errorMessage?: string;
  readonly metadata?: unknown;
  readonly sentAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
