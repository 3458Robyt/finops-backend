import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../application/observability/MetricsRegistry.js';
import type { ServerDependencies } from './server.js';
import { createExpressServer } from './server.js';
import type { RuntimeConfig } from '../infrastructure/config/runtimeConfigTypes.js';

const servers: Server[] = [];

describe('Express security composition', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  it('applies Helmet and an allowlisted credentialed CORS origin', async () => {
    const response = await request('/health', { Origin: 'http://localhost:5173' });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('wires the global API rate limit before API routes', async () => {
    const testServer = await startServer();
    const first = await fetch(`${testServer.url}/api/v1/not-a-route`);
    const second = await fetch(`${testServer.url}/api/v1/not-a-route`);

    expect(first.status).toBe(404);
    expect(second.status).toBe(429);
    expect(second.headers.get('ratelimit-limit')).toBe('1');
    expect(second.headers.get('ratelimit-remaining')).toBe('0');
  });
});

async function request(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const testServer = await startServer();
  return fetch(`${testServer.url}${path}`, { headers });
}

async function startServer(): Promise<{ server: Server; url: string }> {
  const app = createExpressServer(createDependencies());
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function createDependencies(): ServerDependencies {
  const serviceStub = new Proxy({}, { get: () => undefined });
  const runtimeConfig = {
    environment: { nodeEnv: 'test', isProduction: false, processRole: 'api' },
    http: {
      port: 0,
      corsOrigins: ['http://localhost:5173'],
      bodyLimit: '1mb',
      trustProxy: false,
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 35_000,
      keepAliveTimeoutMs: 5_000,
      apiRateLimitPerMinute: 1,
      aiRateLimitPerMinute: 1,
    },
    security: {
      cookieSameSite: 'lax',
      refreshTokenTtlSeconds: 3600,
      clientPortalUrl: 'http://localhost:5173',
    },
  } as unknown as RuntimeConfig;

  return new Proxy({
    runtimeConfig,
    metricsRegistry: new MetricsRegistry(),
    telegramEnabled: false,
  }, {
    get(target, property: string | symbol) {
      if (property in target) return target[property as keyof typeof target];
      return serviceStub;
    },
  }) as unknown as ServerDependencies;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
