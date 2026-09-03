import type { ITelegramRepository } from '../../../domain/interfaces/ITelegramRepository.js';
import type { TelegramChatLink } from '../../../domain/models/Telegram.js';

/** Comandos de selección de tenant disponibles para técnicos multi-tenant. */
export async function formatTenants(repository: ITelegramRepository, link: TelegramChatLink): Promise<string> {
  const tenants = await repository.findTenantOptionsForUser(effectiveUserId(link), effectiveTenantId(link));
  if (tenants.length === 0) return 'No hay tenants disponibles para este usuario.';
  return [
    'Tenants disponibles:',
    '',
    ...tenants.map((tenant, index) => `${index + 1}. ${tenant.name} (${tenant.slug})${tenant.isActive ? ' — activo' : ''}`),
    '',
    'Usa /tenant <numero o slug> para cambiar el tenant activo.',
  ].join('\n');
}

export async function changeTenant(
  repository: ITelegramRepository,
  link: TelegramChatLink,
  selector: string,
): Promise<string> {
  if (link.user?.role === 'CLIENT_APPROVER' || link.user?.role === 'CLIENT_VIEWER') {
    return 'Tu cuenta de cliente está vinculada únicamente a su tenant principal.';
  }

  const tenants = await repository.findTenantOptionsForUser(effectiveUserId(link), effectiveTenantId(link));
  const normalized = selector.trim().toLowerCase();
  const selected = tenants.find((tenant, index) => String(index + 1) === normalized
    || tenant.id.toLowerCase() === normalized
    || tenant.slug.toLowerCase() === normalized
    || tenant.name.toLowerCase() === normalized);
  if (selected === undefined) return 'No encontré ese tenant. Usa /tenants para ver las opciones disponibles.';

  const updated = await repository.setActiveTenantForChat({
    chatId: link.chatId,
    userId: effectiveUserId(link),
    tenantId: selected.id,
  });
  if (updated === null) return 'No fue posible cambiar el tenant. Verifica que siga asignado a tu usuario.';
  return `Tenant activo cambiado a ${selected.name}. Las próximas consultas usarán este tenant.`;
}

function effectiveTenantId(link: TelegramChatLink): string {
  return link.activeTenantId ?? link.tenantId;
}

function effectiveUserId(link: TelegramChatLink): string {
  return link.userId;
}
