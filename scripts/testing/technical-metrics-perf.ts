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

const apiBaseUrl = (process.env['E2E_API_BASE_URL'] ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');
const manifest = JSON.parse(await readFile(resolve(process.env['E2E_FIXTURE_FILE'] ?? '.test-artifacts/e2e-fixtures.json'), 'utf8')) as E2eFixtureManifest;
const token = await login(manifest.admin.email, manifest.password);
const buckets = ['raw', '30m', 'hour', 'day'] as const;
const results = [];

for (const bucket of buckets) {
  const startedAt = Date.now();
  const response = await fetch(`${apiBaseUrl}/technical-metrics/series?bucket=${bucket}&pageSize=5000`, {
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
  return body.accessToken;
}
