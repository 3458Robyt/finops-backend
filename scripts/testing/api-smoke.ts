import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { E2eFixtureManifest } from '../../src/testing/e2eFixtures.js';

interface SmokeResult {
  readonly name: string;
  readonly status: number;
  readonly ok: boolean;
  readonly ms: number;
}

const apiBaseUrl = (process.env['E2E_API_BASE_URL'] ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');
const manifest = await readManifest();
const results: SmokeResult[] = [];

const login = await request('/auth/login', {
  method: 'POST',
  body: JSON.stringify({
    email: manifest.admin.email,
    password: manifest.password,
  }),
});
assertOk(login, 'login');
const loginBody = await login.response.json() as {
  readonly accessToken: string;
  readonly availableTenants: readonly { readonly id: string }[];
};
let token = loginBody.accessToken;

await check('health', `${apiBaseUrl.replace(/\/api\/v1$/, '')}/health`);
await check('auth tenants', '/auth/tenants', token);
await check('kpis savings', '/kpis/savings', token);
await check('costs', '/costs', token);
const createdBudget = await request('/budgets', {
  method: 'POST',
  token,
  body: JSON.stringify({ scope: 'TENANT', period: '2026-05', amount: 100, currency: 'USD' }),
});
assertOk(createdBudget, 'create budget');
const budgetBody = await createdBudget.response.json() as { readonly budget: { readonly id: string } };
await check('budget performance', `/budgets/${encodeURIComponent(budgetBody.budget.id)}/performance`, token);
const firstEvaluation = await request('/budgets/evaluate', { method: 'POST', token, body: JSON.stringify({ budgetId: budgetBody.budget.id }) });
assertOk(firstEvaluation, 'evaluate budget');
const repeatedEvaluation = await request('/budgets/evaluate', { method: 'POST', token, body: JSON.stringify({ budgetId: budgetBody.budget.id }) });
assertOk(repeatedEvaluation, 'repeat budget evaluation');
const budgetAlerts = await request(`/budgets/${encodeURIComponent(budgetBody.budget.id)}/alerts`, { token });
assertOk(budgetAlerts, 'budget alerts');
const budgetAlertsBody = await budgetAlerts.response.json() as { readonly alerts: readonly unknown[] };
if (budgetAlertsBody.alerts.length !== 3) {
  throw new Error(`Expected three idempotent budget alerts, got ${budgetAlertsBody.alerts.length}.`);
}
await check('recommendations', '/recommendations', token);
await check('recommendation detail', `/recommendations/${encodeURIComponent(manifest.recommendationIds[0] ?? '')}`, token);
await check('recommendation timeline', `/recommendations/${encodeURIComponent(manifest.recommendationIds[0] ?? '')}/timeline`, token);
const technicalResources = await request('/technical-metrics/resources', { token });
assertOk(technicalResources, 'technical resources');
const technicalResourcesBody = await technicalResources.response.json() as {
  readonly resources: readonly { readonly externalResourceId: string }[];
};
const smokeResourceId = technicalResourcesBody.resources[0]?.externalResourceId;
if (smokeResourceId === undefined) {
  throw new Error('Technical resources did not return a usable resource identifier.');
}
await check('technical resource summary', `/technical-metrics/resources/${encodeURIComponent(smokeResourceId)}/summary`, token);
const relatedRecommendations = await request(
  `/recommendations?${new URLSearchParams({ externalResourceId: smokeResourceId }).toString()}`,
  { token },
);
assertOk(relatedRecommendations, 'resource related recommendations');
const relatedRecommendationsBody = await relatedRecommendations.response.json() as {
  readonly recommendations: readonly { readonly evidence: { readonly externalResourceId?: string } }[];
};
if (relatedRecommendationsBody.recommendations.some((recommendation) => recommendation.evidence.externalResourceId !== smokeResourceId)) {
  throw new Error('Related recommendations included a different resource.');
}
const technicalOverview = await request('/technical-metrics/overview', { token });
assertOk(technicalOverview, 'technical overview');
const technicalOverviewBody = await technicalOverview.response.json() as {
  readonly overview: {
    readonly minSampledAt?: string;
    readonly maxSampledAt?: string;
    readonly metrics: readonly { readonly metricName: string }[];
  };
};
const smokeMetric = technicalOverviewBody.overview.metrics[0]?.metricName;
const smokeStart = technicalOverviewBody.overview.minSampledAt;
const smokeEnd = technicalOverviewBody.overview.maxSampledAt;
if (smokeMetric === undefined || smokeStart === undefined || smokeEnd === undefined) {
  throw new Error('Technical metrics overview did not return a usable range and metric name.');
}
const technicalSeriesQuery = new URLSearchParams({
  bucket: 'raw',
  pageSize: '50',
  startDate: smokeStart,
  endDate: smokeEnd,
  metricNames: smokeMetric,
});
await check('technical series raw', `/technical-metrics/series?${technicalSeriesQuery.toString()}`, token);
await check('technical coverage', '/technical-metrics/coverage', token);
await check('ai learning summary', '/ai/learning/summary', token);
await check('agent profile', '/agent/profile', token);
await check('notifications', '/notifications', token);
await check('ingestion history', '/ingestion/history', token);

const otherTenant = loginBody.availableTenants.find((tenant) => tenant.id !== manifest.tenants[0]?.id);
if (otherTenant !== undefined) {
  const switched = await request('/auth/switch-tenant', {
    method: 'POST',
    token,
    body: JSON.stringify({ tenantId: otherTenant.id }),
  });
  assertOk(switched, 'switch tenant');
  const switchedBody = await switched.response.json() as { readonly accessToken: string };
  token = switchedBody.accessToken;
  await check('switched tenant recommendations', '/recommendations', token);
}

const unauthorized = await request('/recommendations');
if (unauthorized.response.status !== 401) {
  throw new Error(`Expected unauthorized request to return 401, got ${unauthorized.response.status}`);
}
results.push({ name: 'auth required', status: unauthorized.response.status, ok: true, ms: unauthorized.ms });

console.log(JSON.stringify({
  success: true,
  apiBaseUrl,
  checks: results,
}, null, 2));

async function readManifest(): Promise<E2eFixtureManifest> {
  const fixtureFile = resolve(process.env['E2E_FIXTURE_FILE'] ?? '.test-artifacts/e2e-fixtures.json');
  return JSON.parse(await readFile(fixtureFile, 'utf8')) as E2eFixtureManifest;
}

async function check(name: string, pathOrUrl: string, requestToken?: string): Promise<void> {
  const result = await request(pathOrUrl, { token: requestToken });
  assertOk(result, name);
}

async function request(
  pathOrUrl: string,
  options: { readonly method?: string; readonly token?: string; readonly body?: string } = {},
): Promise<{ readonly response: Response; readonly ms: number }> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${apiBaseUrl}${pathOrUrl}`;
  const startedAt = Date.now();
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  if (options.token !== undefined) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
  });
  return { response, ms: Date.now() - startedAt };
}

function assertOk(result: { readonly response: Response; readonly ms: number }, name: string): void {
  const ok = result.response.status >= 200 && result.response.status < 300;
  results.push({ name, status: result.response.status, ok, ms: result.ms });
  if (!ok) {
    throw new Error(`${name} failed with HTTP ${result.response.status}`);
  }
}
