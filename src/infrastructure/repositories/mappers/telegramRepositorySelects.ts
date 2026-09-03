/** Proyección mínima de usuario reutilizada por las consultas de Telegram. */
export const telegramUserSelect = {
  id: true,
  tenantId: true,
  email: true,
  name: true,
  role: true,
  status: true,
} as const;
