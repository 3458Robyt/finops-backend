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
const billingPeriod = manifest.billingPeriod;
const forecastYear = Number(billingPeriod.slice(0, 4));
const forecastMonth = Number(billingPeriod.slice(5, 7));
if (!Number.isInteger(forecastYear) || !Number.isInteger(forecastMonth) || forecastMonth < 1 || forecastMonth > 12) {
  throw new Error(`Fixture billing period is not a valid YYYY-MM value: ${billingPeriod}`);
}
const forecastFrom = new Date(Date.UTC(forecastYear, forecastMonth - 1, 1));
const forecastTo = new Date(Date.UTC(forecastYear, forecastMonth, 1));
const forecastOutsideTo = new Date(Date.UTC(forecastYear, forecastMonth + 1, 1));

await check('health', `${apiBaseUrl.replace(/\/api\/v1$/, '')}/health`);
await check('auth tenants', '/auth/tenants', token);
const masterJobs = await request('/master-admin/ingestion-jobs?limit=20', { token });
assertOk(masterJobs, 'master ingestion jobs');
const masterJobsBody = await masterJobs.response.json() as {
  readonly jobs: readonly { readonly id: string; readonly status: string }[];
};
const reprocessableJob = masterJobsBody.jobs.find((job) => job.status === 'FAILED');
if (reprocessableJob === undefined) throw new Error('Fixture did not expose a failed ingestion job.');
const reprocess = await request(`/master-admin/ingestion-jobs/${encodeURIComponent(reprocessableJob.id)}/reprocess`, {
  method: 'POST',
  token,
  body: JSON.stringify({ reason: 'API smoke: validar reintento de ventana con error de proveedor.' }),
});
if (reprocess.response.status !== 202) throw new Error(`Expected first reprocess to return 202, got ${reprocess.response.status}.`);
const reprocessBody = await reprocess.response.json() as { readonly originalJobId: string; readonly job: { readonly id: string; readonly status: string }; readonly reusedActiveJob: boolean };
if (reprocessBody.originalJobId !== reprocessableJob.id || reprocessBody.reusedActiveJob || reprocessBody.job.status !== 'PENDING') {
  throw new Error('First reprocess did not create the expected pending replacement job.');
}
results.push({ name: 'master ingestion reprocess creates pending job', status: reprocess.response.status, ok: true, ms: reprocess.ms });
const repeatedReprocess = await request(`/master-admin/ingestion-jobs/${encodeURIComponent(reprocessableJob.id)}/reprocess`, {
  method: 'POST',
  token,
  body: JSON.stringify({ reason: 'API smoke: repetir solicitud y comprobar idempotencia.' }),
});
if (repeatedReprocess.response.status !== 200) throw new Error(`Expected repeated reprocess to return 200, got ${repeatedReprocess.response.status}.`);
const repeatedBody = await repeatedReprocess.response.json() as { readonly reusedActiveJob: boolean; readonly job: { readonly id: string; readonly status: string } };
if (!repeatedBody.reusedActiveJob || repeatedBody.job.id !== reprocessBody.job.id || repeatedBody.job.status !== 'PENDING') {
  throw new Error('Repeated reprocess did not reuse the active replacement job.');
}
results.push({ name: 'master ingestion reprocess reuses active window', status: repeatedReprocess.response.status, ok: true, ms: repeatedReprocess.ms });
await check('kpis savings', '/kpis/savings', token);
await check('costs', '/costs', token);
const analyticsRange = new URLSearchParams({ from: forecastFrom.toISOString(), to: forecastTo.toISOString() });
await check('analytics opportunities', `/analytics/opportunities?${analyticsRange.toString()}`, token);
await check('analytics trends', `/analytics/trends?${analyticsRange.toString()}`, token);
await check('analytics usage', `/analytics/usage?${analyticsRange.toString()}`, token);
await check('analytics unit economics', `/analytics/unit-economics?${analyticsRange.toString()}`, token);
await check('analytics efficiency insights', `/analytics/efficiency-insights?${analyticsRange.toString()}`, token);
const forecast = await request(`/analytics/forecast?${analyticsRange.toString()}`, { token });
assertOk(forecast, 'analytics forecast in range');
const forecastBody = await forecast.response.json() as { readonly forecasts: readonly { readonly forecastMonth: string }[] };
if (forecastBody.forecasts.length === 0 || forecastBody.forecasts.some((item) => {
  const month = Date.parse(item.forecastMonth);
  return Number.isNaN(month) || month < forecastFrom.getTime() || month >= forecastTo.getTime();
})) {
  throw new Error('Analytics forecast returned no fixture forecast or returned a month outside the requested range.');
}
const excludedForecast = await request(`/analytics/forecast?${new URLSearchParams({ from: forecastTo.toISOString(), to: forecastOutsideTo.toISOString() }).toString()}`, { token });
assertOk(excludedForecast, 'analytics forecast excludes out-of-range months');
const excludedForecastBody = await excludedForecast.response.json() as { readonly forecasts: readonly unknown[] };
if (excludedForecastBody.forecasts.length !== 0) {
  throw new Error('Analytics forecast returned a forecast outside the requested range.');
}
const scenarios = await request(`/analytics/forecast/scenarios?${analyticsRange.toString()}`, { token });
assertOk(scenarios, 'analytics forecast scenarios');
const scenariosBody = await scenarios.response.json() as { readonly scenarios: readonly { readonly forecastMonth: string }[] };
if (scenariosBody.scenarios.some((item) => {
  const month = Date.parse(item.forecastMonth);
  return Number.isNaN(month) || month < forecastFrom.getTime() || month >= forecastTo.getTime();
})) {
  throw new Error('Analytics forecast scenarios returned a month outside the requested range.');
}
const invalidAnalyticsDate = await request('/analytics/forecast?from=not-a-date', { token });
if (invalidAnalyticsDate.response.status !== 400) {
  throw new Error(`Expected invalid analytics date to return 400, got ${invalidAnalyticsDate.response.status}.`);
}
results.push({ name: 'analytics invalid date rejected', status: invalidAnalyticsDate.response.status, ok: true, ms: invalidAnalyticsDate.ms });
const allocationRuleInput = { name: 'E2E compute allocation', priority: 10, status: 'DRAFT', serviceName: 'Amazon Elastic Compute Cloud', costCenter: 'E2E-CC' };
const allocationRule = await request('/cost-allocation/rules', {
  method: 'POST', token,
  body: JSON.stringify(allocationRuleInput),
});
assertOk(allocationRule, 'create allocation rule');
const allocationRuleBody = await allocationRule.response.json() as { readonly rule: { readonly id: string } };
const allocationPreview = await request('/cost-allocation/preview', {
  method: 'POST', token,
  body: JSON.stringify({ period: billingPeriod, rule: allocationRuleInput, ruleId: allocationRuleBody.rule.id }),
});
assertOk(allocationPreview, 'preview allocation rule');
const allocationPreviewBody = await allocationPreview.response.json() as { readonly preview: { readonly metricCount: number } };
if (allocationPreviewBody.preview.metricCount === 0) throw new Error('Allocation preview did not match the fixture cost.');
const activatedAllocationRule = await request(`/cost-allocation/rules/${encodeURIComponent(allocationRuleBody.rule.id)}/activate`, { method: 'POST', token });
assertOk(activatedAllocationRule, 'activate allocation rule');
const allocationSummary = await request(`/cost-allocation/summary?period=${encodeURIComponent(billingPeriod)}`, { token });
assertOk(allocationSummary, 'allocation summary');
const allocationSummaryBody = await allocationSummary.response.json() as { readonly summary: readonly { readonly allocatedCost: number }[] };
if (!allocationSummaryBody.summary.some((item) => item.allocatedCost > 0)) throw new Error('Allocation activation did not reduce unallocated fixture cost.');
await check('allocation comparison', `/cost-allocation/comparison?period=${encodeURIComponent(billingPeriod)}`, token);
await check('allocation unallocated', `/cost-allocation/unallocated?period=${encodeURIComponent(billingPeriod)}`, token);
await check('allocation csv', `/cost-allocation/export.csv?period=${encodeURIComponent(billingPeriod)}`, token);
const createdBudget = await request('/budgets', {
  method: 'POST',
  token,
  body: JSON.stringify({ scope: 'TENANT', period: billingPeriod, amount: 100, currency: 'USD' }),
});
assertOk(createdBudget, 'create budget');
const budgetBody = await createdBudget.response.json() as { readonly budget: { readonly id: string } };
const duplicateBudget = await request('/budgets', {
  method: 'POST',
  token,
  body: JSON.stringify({ scope: 'TENANT', period: billingPeriod, amount: 100, currency: 'USD' }),
});
if (duplicateBudget.response.status !== 400) {
  throw new Error(`Expected duplicate budget to return 400, got ${duplicateBudget.response.status}.`);
}
results.push({ name: 'duplicate budget rejected', status: duplicateBudget.response.status, ok: true, ms: duplicateBudget.ms });
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
