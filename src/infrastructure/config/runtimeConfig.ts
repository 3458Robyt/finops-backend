interface RuntimeValidationIssue {
  readonly key: string;
  readonly message: string;
}

const productionOnlyRequired = [
  'DATABASE_URL',
  'JWT_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
  'CORS_ORIGIN',
  'DB_RUNTIME_ENFORCE',
  'DB_RUNTIME_ROLE',
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
    if (jwtSecret !== undefined && jwtSecret.length < 32) {
      issues.push({ key: 'JWT_SECRET', message: 'Debe tener al menos 32 caracteres.' });
    }

    const corsOrigin = env['CORS_ORIGIN'];
    if (corsOrigin !== undefined && corsOrigin.includes('*')) {
      issues.push({ key: 'CORS_ORIGIN', message: 'No debe usar comodines en produccion.' });
    }

    if (env['DB_RUNTIME_ENFORCE'] !== 'true') {
      issues.push({ key: 'DB_RUNTIME_ENFORCE', message: 'Debe ser true en produccion.' });
    }

    if (env['DB_RUNTIME_ROLE'] !== 'finops_runtime') {
      issues.push({ key: 'DB_RUNTIME_ROLE', message: 'Debe ser finops_runtime en produccion.' });
    }
  }

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
