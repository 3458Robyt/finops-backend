import type { TelegramChatLink } from '../../../domain/models/Telegram.js';
import { runWithDatabaseContext } from '../../../infrastructure/database/tenantContext.js';

export function effectiveTelegramTenantId(link: TelegramChatLink): string {
  return link.activeTenantId ?? link.tenantId;
}

export function runTelegramTenantContext<T>(link: TelegramChatLink, callback: () => T): T {
  return runWithDatabaseContext({
    tenantId: effectiveTelegramTenantId(link),
    userId: link.userId,
    role: link.user?.role ?? 'FINOPS_TECHNICIAN',
    workerId: 'telegram-inbound',
  }, callback);
}

export function retryTelegramUpdateDelay(baseMs: number, attempts: number): number {
  const base = Math.max(1_000, baseMs);
  return Math.min(base * (2 ** Math.max(0, attempts - 1)), 60 * 60 * 1000);
}
