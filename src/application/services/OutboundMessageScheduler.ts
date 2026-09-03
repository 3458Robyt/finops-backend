import type { AuthContext } from '../../domain/models/AuthContext.js';
import { safeErrorMessage } from '../observability/safeError.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';
import type { OutboundMessageService } from './OutboundMessageService.js';
import { startNonOverlappingLoop, type NonOverlappingLoopHandle } from './NonOverlappingLoop.js';
import type { MetricsRegistry } from '../observability/MetricsRegistry.js';

export class OutboundMessageScheduler {
  private loop: NonOverlappingLoopHandle | undefined;

  constructor(
    private readonly outboundMessageService: OutboundMessageService,
    private readonly systemActor: AuthContext | undefined,
    private readonly options: {
      readonly intervalMinutes: number;
      readonly deliveryBatchSize: number;
      readonly deliveryLeaseMs: number;
      readonly deliveryRetryBackoffMs: number;
      readonly metrics?: MetricsRegistry;
      readonly metricLabels?: Readonly<Record<string, string>>;
    },
  ) {}

  public start(): void {
    if (this.loop !== undefined) {
      return;
    }

    const intervalMs = Math.max(5, this.options.intervalMinutes) * 60 * 1000;
    this.loop = startNonOverlappingLoop({
      run: () => this.runOnce(),
      intervalMs,
      fallbackIntervalMs: 5 * 60 * 1000,
      runImmediately: false,
      unref: true,
      metricName: 'outbound_message_scheduler_iteration',
      ...(this.options.metrics === undefined ? {} : { metrics: this.options.metrics }),
      ...(this.options.metricLabels === undefined ? {} : { metricLabels: this.options.metricLabels }),
      onError: (error) => console.error(JSON.stringify({ level: 'error', event: 'outbound_message_scheduler_iteration_failed', error: safeErrorMessage(error) })),
    });
  }

  public async runOnce(): Promise<void> {
    const actor = this.systemActor;
    let processed = 0;
    await runWithDatabaseContext(
      {
        role: 'MASTER_ADMIN',
        workerId: 'message-scheduler',
      },
      async () => {
        const batchSize = Math.max(1, Math.min(this.options.deliveryBatchSize, 500));
        while (processed < batchSize) {
          const result = await this.outboundMessageService.processNextPendingDelivery({
            workerId: 'message-scheduler',
            leaseMs: this.options.deliveryLeaseMs,
            retryBackoffMs: this.options.deliveryRetryBackoffMs,
          });
          if (!result.processed) break;
          processed += 1;
        }
      },
    );
    if (processed > 0) {
      console.log(JSON.stringify({ level: 'info', event: 'outbound_message_deliveries_processed', count: processed }));
    }
    if (actor === undefined) return;
    await runWithDatabaseContext(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        role: actor.role,
        loginEmail: actor.email,
        workerId: 'message-scheduler',
      },
      async () => {
        await this.outboundMessageService.sendSavingsReminders(actor);
        if (typeof this.outboundMessageService.sendExecutiveSummaryIfConfigured === 'function') {
          await this.outboundMessageService.sendExecutiveSummaryIfConfigured(actor);
        }
      },
    );
  }

  public async stop(): Promise<void> {
    if (this.loop !== undefined) {
      const loop = this.loop;
      loop.stop();
      this.loop = undefined;
      await loop.waitForIdle();
    }
  }
}
