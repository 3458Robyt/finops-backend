interface RuntimeValidationIssue {
  readonly key: string;
  readonly message: string;
}

const productionOnlyRequired = [
  'DATABASE_URL',
  'APP_PROCESS_ROLE',
  'JWT_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
  'CORS_ORIGIN',
  'DB_RUNTIME_ENFORCE',
  'DB_RUNTIME_ROLE',
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_AUDITOR_MODEL',
  'MFA_REQUIRED_FOR_PRIVILEGED',
  'METRICS_TOKEN',
] as const;

export function validateRuntimeConfig(env: NodeJS.ProcessEnv = process.env): void {
  const issues: RuntimeValidationIssue[] = [];
  const isProduction = env['NODE_ENV'] === 'production';

  if (isProduction) {
    for (const key of productionOnlyRequired) {
      if (isBlank(env[key])) {
        issues.push({ key, message: 'Variable obligatoria en produccion.' });
      }
    }

    const jwtSecret = env['JWT_SECRET'];
    if (jwtSecret !== undefined && (jwtSecret.length < 32 || isKnownPlaceholder(jwtSecret))) {
      issues.push({ key: 'JWT_SECRET', message: 'Debe tener al menos 32 caracteres.' });
    }

    const encryptionKey = env['CREDENTIAL_ENCRYPTION_KEY'];
    if (encryptionKey !== undefined && !isBase64KeyOf32Bytes(encryptionKey)) {
      issues.push({ key: 'CREDENTIAL_ENCRYPTION_KEY', message: 'Debe ser una clave base64 que decodifique a 32 bytes.' });
    }

    validateCorsOrigins(env['CORS_ORIGIN'], issues);

    if (env['DB_RUNTIME_ENFORCE'] !== 'true') {
      issues.push({ key: 'DB_RUNTIME_ENFORCE', message: 'Debe ser true en produccion.' });
    }

    if (env['DB_RUNTIME_ROLE'] !== 'finops_runtime') {
      issues.push({ key: 'DB_RUNTIME_ROLE', message: 'Debe ser finops_runtime en produccion.' });
    }

    validateProcessRole(env['APP_PROCESS_ROLE'], issues);

    if (env['MFA_REQUIRED_FOR_PRIVILEGED'] !== 'true') {
      issues.push({ key: 'MFA_REQUIRED_FOR_PRIVILEGED', message: 'Debe ser true en produccion.' });
    }

    if (!isHttpUrl(env['AI_BASE_URL'])) {
      issues.push({ key: 'AI_BASE_URL', message: 'Debe ser una URL HTTP(S) válida.' });
    }
    validatePositiveBound(env, 'AI_TIMEOUT_MS', 5_000, 120_000, issues);
    validatePositiveBound(env, 'LEARNING_AUDIT_TIMEOUT_MS', 5_000, 60_000, issues);
    validateIntegerBound(env, 'AI_MAX_RETRIES', 0, 2, issues);
    validatePositiveBound(env, 'HTTP_REQUEST_TIMEOUT_MS', 1_000, 300_000, issues);
    validatePositiveBound(env, 'HTTP_HEADERS_TIMEOUT_MS', 1_000, 120_000, issues);
    validatePositiveBound(env, 'HTTP_KEEP_ALIVE_TIMEOUT_MS', 1_000, 120_000, issues);
    validatePositiveBound(env, 'AUTH_REFRESH_TOKEN_TTL_SECONDS', 300, 90 * 24 * 60 * 60, issues);
    validatePositiveBound(env, 'PASSWORD_RESET_TTL_SECONDS', 300, 3600, issues);
    if (env['EMAIL_ENABLED'] === 'true' && !isHttpUrl(env['PASSWORD_RESET_URL'])) {
      issues.push({ key: 'PASSWORD_RESET_URL', message: 'Debe ser una URL HTTP(S) válida cuando el correo está habilitado.' });
    }
    validatePositiveBound(env, 'INGESTION_SCHEDULER_VALIDATION_MAX_AGE_MINUTES', 5, 7 * 24 * 60, issues);
  }

  validateEnabledIntegrations(env, issues);

  if (issues.length > 0) {
    const details = issues.map((issue) => `${issue.key}: ${issue.message}`).join(' ');
    throw new Error(`Configuracion runtime invalida. ${details}`);
  }

  if (!isProduction) {
    const missing = productionOnlyRequired.filter((key) => isBlank(env[key]));
    if (missing.length > 0) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'runtime_config_dev_warning',
        message: 'Faltan variables requeridas para produccion; permitido en desarrollo.',
        missing,
      }));
    }
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

function isKnownPlaceholder(value: string): boolean {
  return /replace_with|your_|example\.com|change_me/i.test(value);
}

function isBase64KeyOf32Bytes(value: string): boolean {
  if (isKnownPlaceholder(value)) return false;
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string | undefined): boolean {
  if (isBlank(value)) return false;
  try {
    const url = new URL(value!);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateCorsOrigins(value: string | undefined, issues: RuntimeValidationIssue[]): void {
  if (isBlank(value)) return;

  const origins = value!.split(',').map((item) => item.trim()).filter(Boolean);
  if (origins.length === 0) {
    issues.push({ key: 'CORS_ORIGIN', message: 'Debe declarar al menos un origen HTTP(S).' });
    return;
  }

  for (const origin of origins) {
    if (origin.includes('*')) {
      issues.push({ key: 'CORS_ORIGIN', message: 'No debe usar comodines en produccion.' });
      continue;
    }

    try {
      const url = new URL(origin);
      const hasPathOrCredentials = url.pathname !== '/' || url.search !== '' || url.hash !== ''
        || url.username !== '' || url.password !== '';
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || hasPathOrCredentials) {
        issues.push({ key: 'CORS_ORIGIN', message: 'Debe contener únicamente orígenes HTTP(S) sin rutas ni credenciales.' });
      }
    } catch {
      issues.push({ key: 'CORS_ORIGIN', message: 'Debe contener orígenes HTTP(S) válidos separados por coma.' });
    }
  }
}

function validateProcessRole(value: string | undefined, issues: RuntimeValidationIssue[]): void {
  const role = value?.trim().toLowerCase();
  if (role !== 'api' && role !== 'worker' && role !== 'scheduler' && role !== 'all') {
    issues.push({ key: 'APP_PROCESS_ROLE', message: 'Debe ser api, worker, scheduler o all.' });
  }
}

function validateEnabledIntegrations(env: NodeJS.ProcessEnv, issues: RuntimeValidationIssue[]): void {
  if (env['EMAIL_ENABLED'] === 'true') {
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) {
      if (isBlank(env[key])) issues.push({ key, message: 'Es obligatoria cuando EMAIL_ENABLED=true.' });
    }
  }

  if (env['TELEGRAM_ENABLED'] === 'true') {
    for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET']) {
      if (isBlank(env[key])) issues.push({ key, message: 'Es obligatoria cuando TELEGRAM_ENABLED=true.' });
    }
  }

  if (env['MESSAGE_SCHEDULER_ENABLED'] === 'true') {
    for (const key of ['MESSAGE_SCHEDULER_TENANT_ID', 'MESSAGE_SCHEDULER_USER_ID']) {
      if (isBlank(env[key])) issues.push({ key, message: 'Es obligatoria cuando MESSAGE_SCHEDULER_ENABLED=true.' });
    }
  }

  if (env['SAVINGS_RECONCILIATION_SCHEDULER_ENABLED'] === 'true'
    && isBlank(env['SAVINGS_RECONCILIATION_TENANT_ID'])) {
    issues.push({
      key: 'SAVINGS_RECONCILIATION_TENANT_ID',
      message: 'Es obligatoria cuando SAVINGS_RECONCILIATION_SCHEDULER_ENABLED=true.',
    });
  }
}

function validatePositiveBound(
  env: NodeJS.ProcessEnv,
  key: string,
  minimum: number,
  maximum: number,
  issues: RuntimeValidationIssue[],
): void {
  const value = env[key];
  if (value === undefined) return;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push({ key, message: `Debe ser un entero entre ${minimum} y ${maximum}.` });
  }
}

function validateIntegerBound(
  env: NodeJS.ProcessEnv,
  key: string,
  minimum: number,
  maximum: number,
  issues: RuntimeValidationIssue[],
): void {
  const value = env[key];
  if (value === undefined) return;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push({ key, message: `Debe ser un entero entre ${minimum} y ${maximum}.` });
  }
}
