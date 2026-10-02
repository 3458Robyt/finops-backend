import 'dotenv/config';

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { E2eFixtureManifest } from '../../src/testing/e2eFixtures.js';

interface SeriesResponse {
  readonly success: true;
  readonly meta: {
    readonly returnedPoints: number;
    readonly totalSamples: number;
    readonly queryMs: number;
    readonly hasMore: boolean;
    readonly bucket: string;
  };
}

interface OverviewResponse {
  readonly success: true;
  readonly overview: {
    readonly maxSampledAt?: string;
    readonly resources: readonly {
      readonly externalResourceId: string;
      readonly cloudResourceId?: string;
      readonly metricNames?: readonly string[];
    }[];
    readonly metrics: readonly {
      readonly metricName: string;
    }[];
  };
}

const apiBaseUrl = (process.env['E2E_API_BASE_URL'] ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');
const manifest = JSON.parse(await readFile(resolve(process.env['E2E_FIXTURE_FILE'] ?? '.test-artifacts/e2e-fixtures.json'), 'utf8')) as E2eFixtureManifest;
let token = await login(manifest.admin.email, manifest.password);
if (process.env['PERF_TENANT_ID'] !== undefined) {
  token = await switchTenant(token, process.env['PERF_TENANT_ID']);
}
const overview = await loadOverview(token);
const resource = overview.resources[0];
const metricName = resource?.metricNames?.[0] ?? overview.metrics[0]?.metricName;
if (metricName === undefined) {
  throw new Error('No technical metric is available for the performance probe.');
}

const endDate = process.env['PERF_END_DATE'] ?? overview.maxSampledAt ?? new Date().toISOString();
const startDate = process.env['PERF_START_DATE'] ?? new Date(Date.parse(endDate) - 24 * 60 * 60 * 1000).toISOString();
const baseParams = new URLSearchParams({ startDate, endDate, metricNames: metricName, statistic: 'MEAN' });
if (resource !== undefined) {
  baseParams.set('externalResourceId', resource.externalResourceId);
  if (resource.cloudResourceId !== undefined) baseParams.set('cloudResourceId', resource.cloudResourceId);
}
const buckets = ['raw', '30m', 'hour', 'day'] as const;
const results = [];

for (const bucket of buckets) {
  const startedAt = Date.now();
  const query = new URLSearchParams(baseParams);
  query.set('bucket', bucket);
  query.set('pageSize', '5000');
  const response = await fetch(`${apiBaseUrl}/technical-metrics/series?${query.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`technical metrics ${bucket} failed with HTTP ${response.status}`);
  }
  const body = await response.json() as SeriesResponse;
  results.push({
    bucket,
    httpMs: Date.now() - startedAt,
    queryMs: body.meta.queryMs,
    returnedPoints: body.meta.returnedPoints,
    totalSamples: body.meta.totalSamples,
    hasMore: body.meta.hasMore,
    startDate,
    endDate,
    metricName,
    resource: resource?.externalResourceId,
  });
}

await mkdir(resolve('.test-artifacts/perf'), { recursive: true });
const outputFile = resolve('.test-artifacts/perf/technical-metrics-latest.json');
await writeFile(outputFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  success: true,
  outputFile,
  results,
}, null, 2));

async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(`login failed with HTTP ${response.status}`);
  }
  const body = await response.json() as { readonly accessToken: string };
  if (typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
    throw new Error('Login did not return an access token. Complete MFA or use a test account without MFA.');
  }
  return body.accessToken;
}

async function loadOverview(token: string): Promise<OverviewResponse['overview']> {
  const response = await fetch(`${apiBaseUrl}/technical-metrics/overview`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`technical metrics overview failed with HTTP ${response.status}`);
  }
  const body = await response.json() as OverviewResponse;
  return body.overview;
}

async function switchTenant(token: string, tenantId: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/auth/switch-tenant`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tenantId }),
  });
  if (!response.ok) {
    throw new Error(`tenant switch failed with HTTP ${response.status}`);
  }
  const body = await response.json() as { readonly accessToken?: unknown };
  if (typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
    throw new Error('Tenant switch did not return an access token.');
  }
  return body.accessToken;
}
