import type { AuthContext } from '../../domain/models/AuthContext.js';
import { safeErrorMessage } from '../observability/safeError.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';
import type { OutboundMessageService } from './OutboundMessageService.js';
import { startNonOverlappingLoop, type NonOverlappingLoopHandle } from './NonOverlappingLoop.js';

export class OutboundMessageScheduler {
  private loop: NonOverlappingLoopHandle | undefined;

  constructor(
    private readonly outboundMessageService: OutboundMessageService,
    private readonly systemActor: AuthContext | undefined,
    private readonly intervalMinutes: number,
  ) {}

  public start(): void {
    if (this.systemActor === undefined || this.loop !== undefined) {
      return;
    }

    const intervalMs = Math.max(5, this.intervalMinutes) * 60 * 1000;
    this.loop = startNonOverlappingLoop({
      run: () => {
        const actor = this.systemActor as AuthContext;
        return runWithDatabaseContext(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            role: actor.role,
            loginEmail: actor.email,
            workerId: 'message-scheduler',
          },
          () => this.outboundMessageService.sendSavingsReminders(actor),
        );
      },
      intervalMs,
      fallbackIntervalMs: 5 * 60 * 1000,
      runImmediately: false,
      unref: true,
      onError: (error) => console.error(JSON.stringify({ level: 'error', event: 'outbound_message_scheduler_iteration_failed', error: safeErrorMessage(error) })),
    });
  }

  public stop(): void {
    if (this.loop !== undefined) {
      this.loop.stop();
      this.loop = undefined;
    }
  }
}
