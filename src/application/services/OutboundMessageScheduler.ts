import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { OutboundMessageService } from './OutboundMessageService.js';

export class OutboundMessageScheduler {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly outboundMessageService: OutboundMessageService,
    private readonly systemActor: AuthContext | undefined,
    private readonly intervalMinutes: number,
  ) {}

  public start(): void {
    if (this.systemActor === undefined || this.timer !== undefined) {
      return;
    }

    const intervalMs = Math.max(5, this.intervalMinutes) * 60 * 1000;
    this.timer = setInterval(() => {
      void this.outboundMessageService.sendSavingsReminders(this.systemActor as AuthContext);
    }, intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
