import type { AuthContext } from '../../domain/models/AuthContext.js';
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
      run: () => this.outboundMessageService.sendSavingsReminders(this.systemActor as AuthContext),
      intervalMs,
      fallbackIntervalMs: 5 * 60 * 1000,
      runImmediately: false,
      unref: true,
      onError: (error) => console.error('Outbound message scheduler iteration failed:', error),
    });
  }

  public stop(): void {
    if (this.loop !== undefined) {
      this.loop.stop();
      this.loop = undefined;
    }
  }
}
