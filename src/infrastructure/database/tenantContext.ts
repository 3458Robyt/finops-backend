import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import type { UserRole } from '../../domain/models/AuthContext.js';
import { loadRuntimeConfig } from '../config/runtimeConfigReader.js';

export interface TenantDatabaseRuntimeConfig {
  readonly runtimeEnforce: boolean;
  readonly runtimeRole: string;
}

export interface DatabaseContext {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly role?: UserRole;
  readonly loginEmail?: string;
  readonly refreshTokenHash?: string;
  readonly passwordResetTokenHash?: string;
  readonly mfaChallengeTokenHash?: string;
  readonly clientInvitationTokenHash?: string;
  readonly telegramLinkTokenHash?: string;
  readonly requestId?: string;
  readonly workerId?: string;
}

const contextStorage = new AsyncLocalStorage<DatabaseContext>();
const contextKeys = ['app.tenant_id', 'app.user_id', 'app.user_role', 'app.login_email', 'app.refresh_token_hash', 'app.password_reset_token_hash', 'app.mfa_challenge_token_hash', 'app.client_invitation_token_hash', 'app.telegram_link_token_hash', 'app.request_id', 'app.worker_id'] as const;

export function runWithDatabaseContext<T>(context: DatabaseContext, callback: () => T): T {
  const store = { ...context };
  const result = contextStorage.run(store, callback);

  // Prisma's driver-adapter client returns a thenable (PrismaPromise), not a
  // native Promise. If the thenable is returned directly, the caller's
  // `await` attaches `.then()` after AsyncLocalStorage.run() has already
  // finished, so the database pool cannot see the tenant/worker context. By
  // assimilating the thenable while the context is still active, the native
  // promise chain used by the adapter retains the correct context.
  if (isThenable(result)) {
    return contextStorage.run(store, () => Promise.resolve(result)) as T;
  }

  return result;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function';
}

export function getDatabaseContext(): DatabaseContext | undefined {
  return contextStorage.getStore();
}

export function createTenantAwarePool(
  connectionString: string,
  schema: string | undefined,
  runtimeConfig: TenantDatabaseRuntimeConfig = loadRuntimeConfig().database,
): Pool {
  return new TenantAwarePool({
    connectionString,
    options: buildPostgresSessionOptions(schema),
  }, runtimeConfig);
}

/**
 * Prisma's PostgreSQL driver adapter serializes Date values as UTC text
 * without an explicit offset. Pin every application session to UTC so
 * PostgreSQL interprets those values as the same instant instead of applying
 * the machine's local timezone.
 */
export function buildPostgresSessionOptions(schema?: string): string {
  return [
    schema === undefined ? undefined : `-c search_path=${schema}`,
    '-c timezone=UTC',
  ].filter((option): option is string => option !== undefined).join(' ');
}

class TenantAwarePool extends Pool {
  public constructor(
    options: ConstructorParameters<typeof Pool>[0],
    private readonly runtimeConfig: TenantDatabaseRuntimeConfig,
  ) {
    super(options);
  }

  public override query(...args: any[]): Promise<any> {
    if (!this.runtimeConfig.runtimeEnforce && getDatabaseContext() === undefined) {
      return Reflect.apply(Pool.prototype.query, this, args) as Promise<any>;
    }

    return this.connect().then(async (client) => {
      try {
        const runQuery = client.query as unknown as (...queryArgs: any[]) => Promise<any>;
        return await runQuery(...args);
      } finally {
        client.release();
      }
    });
  }

  public override async connect(): Promise<PoolClient> {
    const client = await super.connect();
    return wrapPoolClient(client, this.runtimeConfig);
  }
}

function wrapPoolClient(client: PoolClient, runtimeConfig: TenantDatabaseRuntimeConfig): PoolClient {
  const originalQuery = client.query.bind(client) as PoolClient['query'];
  const originalRelease = client.release.bind(client);
  let transactionDepth = 0;
  let contextApplied = false;
  let queue = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const query = ((...args: unknown[]) => enqueue(async () => {
    const sql = getQueryText(args[0]);
    if (sql === undefined) {
      return originalQuery(...(args as Parameters<PoolClient['query']>));
    }

    const command = sql.trim().split(/\s+/, 1)[0]?.toUpperCase();
    if (command === 'BEGIN') {
      const result = await originalQuery(...(args as Parameters<PoolClient['query']>));
      transactionDepth += 1;
      if (transactionDepth === 1) {
        contextApplied = true;
        try {
          await applyContext(originalQuery, getDatabaseContext(), runtimeConfig);
        } catch (error) {
          await clearContext(originalQuery, runtimeConfig).catch(() => undefined);
          contextApplied = false;
          throw error;
        }
      }
      return result;
    }

    if (command === 'COMMIT' || command === 'ROLLBACK') {
      const result = await originalQuery(...(args as Parameters<PoolClient['query']>));
      transactionDepth = Math.max(0, transactionDepth - 1);
      if (transactionDepth === 0 && contextApplied) {
        await clearContext(originalQuery, runtimeConfig);
        contextApplied = false;
      }
      return result;
    }

    if (transactionDepth > 0) {
      return originalQuery(...(args as Parameters<PoolClient['query']>));
    }

    const context = getDatabaseContext();
    if (!runtimeConfig.runtimeEnforce && context === undefined) {
      return originalQuery(...(args as Parameters<PoolClient['query']>));
    }

    contextApplied = true;
    try {
      await applyContext(originalQuery, context, runtimeConfig);
      const result = await originalQuery(...(args as Parameters<PoolClient['query']>));
      return result;
    } finally {
      await clearContext(originalQuery, runtimeConfig);
      contextApplied = false;
    }
  })) as PoolClient['query'];

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'query') return query;
      if (property === 'release') {
        return (error?: Error | boolean) => {
          void enqueue(async () => {
            if (contextApplied) {
              await clearContext(originalQuery, runtimeConfig).catch(() => undefined);
              contextApplied = false;
            }
            originalRelease(error);
          });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function getQueryText(query: unknown): string | undefined {
  if (typeof query === 'string') return query;
  if (query !== null && typeof query === 'object' && 'text' in query && typeof query.text === 'string') {
    return query.text;
  }
  return undefined;
}

async function applyContext(
  query: PoolClient['query'],
  context: DatabaseContext | undefined,
  runtimeConfig: TenantDatabaseRuntimeConfig,
): Promise<void> {
  if (runtimeConfig.runtimeEnforce) {
    await query(`set role ${quoteIdentifier(runtimeConfig.runtimeRole)}`);
  }

  await setContextValues(query, contextEntries(context));
}

async function clearContext(
  query: PoolClient['query'],
  runtimeConfig: TenantDatabaseRuntimeConfig,
): Promise<void> {
  await setContextValues(query, contextKeys.map((key) => [key, ''] as const));
  if (runtimeConfig.runtimeEnforce) {
    await query('reset role');
  }
}

async function setContextValues(
  query: PoolClient['query'],
  entries: readonly (readonly [string, string])[],
): Promise<void> {
  const values = entries.flatMap(([key, value]) => [key, value]);
  const placeholders = entries
    .map((_, index) => `set_config($${index * 2 + 1}, $${index * 2 + 2}, false)`)
    .join(', ');
  await query({
    text: `select ${placeholders}`,
    values,
  });
}

function contextEntries(context: DatabaseContext | undefined): readonly [string, string][] {
  return [
    ['app.tenant_id', context?.tenantId ?? ''],
    ['app.user_id', context?.userId ?? ''],
    ['app.user_role', context?.role ?? ''],
    ['app.login_email', context?.loginEmail ?? ''],
    ['app.refresh_token_hash', context?.refreshTokenHash ?? ''],
    ['app.password_reset_token_hash', context?.passwordResetTokenHash ?? ''],
    ['app.mfa_challenge_token_hash', context?.mfaChallengeTokenHash ?? ''],
    ['app.client_invitation_token_hash', context?.clientInvitationTokenHash ?? ''],
    ['app.telegram_link_token_hash', context?.telegramLinkTokenHash ?? ''],
    ['app.request_id', context?.requestId ?? ''],
    ['app.worker_id', context?.workerId ?? ''],
  ];
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
