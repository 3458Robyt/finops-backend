const LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Maintenance commands that repair local FinOps data may only target its configured dev database. */
export function assertLocalFinopsDatabaseTarget(connectionString: string | undefined): void {
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('DATABASE_URL debe apuntar a PostgreSQL local 127.0.0.1:5433/finops_local.');
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL debe apuntar a PostgreSQL local 127.0.0.1:5433/finops_local.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname.toLowerCase() !== '127.0.0.1'
    || url.port !== '5433'
    || url.pathname !== '/finops_local') {
    throw new Error('DATABASE_URL debe apuntar a PostgreSQL local 127.0.0.1:5433/finops_local.');
  }
}

/**
 * Manual maintenance scripts are local-development tools. Refuse to mutate a
 * remote database unless the operator opts in explicitly.
 */
export function assertLocalMutationTarget(
  connectionString: string | undefined,
  allowRemote = process.env['ALLOW_REMOTE_SCRIPT_WRITES'] === 'true',
): void {
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('DATABASE_URL debe apuntar a la base local antes de ejecutar un script de escritura.');
  }

  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname.toLowerCase();
  } catch {
    throw new Error('DATABASE_URL no contiene una URL PostgreSQL válida.');
  }

  if (LOCAL_DATABASE_HOSTS.has(hostname) || allowRemote) return;

  throw new Error(
    `Se rechazó una escritura manual contra la base remota ${hostname}. `
    + 'Configura DATABASE_URL a PostgreSQL local; usa ALLOW_REMOTE_SCRIPT_WRITES=true solo con autorización explícita.',
  );
}
