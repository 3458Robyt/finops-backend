import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import type { UserRole } from '../../domain/models/AuthContext.js';

export interface DatabaseContext {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly role?: UserRole;
  readonly loginEmail?: string;
  readonly requestId?: string;
  readonly workerId?: string;
}

const contextStorage = new AsyncLocalStorage<DatabaseContext>();
const contextKeys = ['app.tenant_id', 'app.user_id', 'app.user_role', 'app.login_email', 'app.request_id', 'app.worker_id'] as const;

export function runWithDatabaseContext<T>(context: DatabaseContext, callback: () => T): T {
  return contextStorage.run({ ...context }, callback);
}

export function getDatabaseContext(): DatabaseContext | undefined {
  return contextStorage.getStore();
}

export function createTenantAwarePool(connectionString: string, schema?: string): Pool {
  return new TenantAwarePool({
    connectionString,
    ...(schema === undefined ? {} : { options: `-c search_path=${schema}` }),
  });
}

class TenantAwarePool extends Pool {
  public override query(...args: any[]): Promise<any> {
    if (!runtimeEnforcementEnabled() && getDatabaseContext() === undefined) {
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
    return wrapPoolClient(client);
  }
}

function wrapPoolClient(client: PoolClient): PoolClient {
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
          await applyContext(originalQuery, getDatabaseContext());
        } catch (error) {
          await clearContext(originalQuery).catch(() => undefined);
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
        await clearContext(originalQuery);
        contextApplied = false;
      }
      return result;
    }

    if (transactionDepth > 0) {
      return originalQuery(...(args as Parameters<PoolClient['query']>));
    }

    const context = getDatabaseContext();
    if (!runtimeEnforcementEnabled() && context === undefined) {
      return originalQuery(...(args as Parameters<PoolClient['query']>));
    }

    contextApplied = true;
    try {
      await applyContext(originalQuery, context);
      const result = await originalQuery(...(args as Parameters<PoolClient['query']>));
      return result;
    } finally {
      await clearContext(originalQuery);
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
              await clearContext(originalQuery).catch(() => undefined);
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
): Promise<void> {
  if (runtimeEnforcementEnabled()) {
    await query(`set role ${quoteIdentifier(runtimeRole())}`);
  }

  await setContextValues(query, contextEntries(context));
}

async function clearContext(query: PoolClient['query']): Promise<void> {
  await setContextValues(query, contextKeys.map((key) => [key, ''] as const));
  if (runtimeEnforcementEnabled()) {
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
    ['app.request_id', context?.requestId ?? ''],
    ['app.worker_id', context?.workerId ?? ''],
  ];
}

function runtimeEnforcementEnabled(): boolean {
  return process.env['DB_RUNTIME_ENFORCE'] === 'true';
}

function runtimeRole(): string {
  const role = process.env['DB_RUNTIME_ROLE'] ?? 'finops_runtime';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) {
    throw new Error('DB_RUNTIME_ROLE must be a valid PostgreSQL identifier');
  }
  return role;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
