import type { TelegramChatLink } from '../../../domain/models/Telegram.js';

export function effectiveTelegramTenantId(link: TelegramChatLink): string {
  return link.activeTenantId ?? link.tenantId;
}

export function retryTelegramUpdateDelay(baseMs: number, attempts: number): number {
  const base = Math.max(1_000, baseMs);
  return Math.min(base * (2 ** Math.max(0, attempts - 1)), 60 * 60 * 1000);
}
