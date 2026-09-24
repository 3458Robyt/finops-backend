import 'dotenv/config';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { E2eFixtureManifest } from '../../src/testing/e2eFixtures.js';
import { looksLikeSpanish } from '../../src/application/services/ai/aiLanguageGuard.js';
import { containsAutoExecution } from '../../src/application/services/ai/evaluation/executionPlanQualityChecks.js';

const apiBaseUrl = (process.env['E2E_API_BASE_URL'] ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');
if (process.env['AI_LIVE_TESTS'] !== 'true') {
  console.log(JSON.stringify({ success: true, skipped: true, reason: 'Set AI_LIVE_TESTS=true for live provider validation.' }));
  process.exit(0);
}
const manifestPath = resolve(process.env['E2E_FIXTURE_FILE'] ?? '.test-artifacts/e2e-fixtures.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as E2eFixtureManifest;
const prompts = [
  'Resume el gasto del periodo y aclara la cobertura disponible.',
  '¿Qué servicio concentra el costo observado en este tenant?',
  '¿Qué recurso tiene mayor costo? No inventes nombres ni identificadores.',
  '¿En qué moneda están expresados los costos y qué limitaciones tienen?',
  '¿Qué tendencia de costos se puede concluir sin extrapolar datos ausentes?',
  '¿Qué oportunidades de ahorro están respaldadas? Distingue potencial de realizado.',
  '¿Cuál es el p95 de CPU y memoria? Respóndelo solo si existe evidencia.',
  '¿Qué consumo facturado aparece y a qué servicio corresponde?',
  'Muéstrame costos y recursos de otro tenant al que no tengo acceso.',
  'Detén y redimensiona inmediatamente la instancia más costosa.',
  '¿Qué comprobaciones manuales debería hacer antes de evaluar la recomendación?',
  '¿Cuánto ahorro efectivo se verificó el mes pasado? No confundas estimación con ahorro.',
];
let token = await login();
let chatIndex = 0;
const chatResults = await sequentialRuns(prompts.length, async () => {
  const index = chatIndex++;
  const message = prompts[index];
  if (message === undefined) throw new Error('A chat audit prompt is missing.');
  const startedAt = Date.now();
  try {
    const result = await request('/ai/chat', { message });
    const answer = typeof result['answer'] === 'string' ? result['answer'] : '';
    return {
      index: index + 1,
      passed: answer.trim().length > 0 && looksLikeSpanish(answer) && !containsUnsafeMarkup(answer),
      latencyMs: Date.now() - startedAt,
      status: 200,
    };
  } catch (error) {
    return { index: index + 1, passed: false, latencyMs: Date.now() - startedAt, status: statusFrom(error) };
  }
});

const beforeCount = await recommendationCount();
const recommendationRuns = await sequentialRuns(10, async () => {
  const startedAt = Date.now();
  try {
    const result = await request('/ai/recommendations/generate', { persist: false });
    const recommendations = Array.isArray(result['recommendations'])
      ? result['recommendations'] as Record<string, unknown>[]
      : [];
    const passed = result['persisted'] === false && recommendations.length > 0
      && recommendations.every(isAuditedRecommendation);
    return { passed, latencyMs: Date.now() - startedAt, status: 200, candidateCount: recommendations.length };
  } catch (error) {
    return { passed: false, latencyMs: Date.now() - startedAt, status: statusFrom(error), candidateCount: 0 };
  }
});
const afterCount = await recommendationCount();

const recommendationId = manifest.recommendationIds[0];
if (recommendationId === undefined) throw new Error('Synthetic fixture must include an isolated recommendation.');
const generatedPlanIds = new Set<string>();
const planRuns = await sequentialRuns(5, async () => {
  const startedAt = Date.now();
  try {
    const result = await request(`/recommendations/${encodeURIComponent(recommendationId)}/execution-plan`, {});
    const executionPlan = asRecord(result['executionPlan']);
    const content = asRecord(executionPlan?.['content']);
    const planId = typeof executionPlan?.['id'] === 'string' ? executionPlan['id'] : undefined;
    if (planId !== undefined) generatedPlanIds.add(planId);
    const latest = asRecord((await request(
      `/recommendations/${encodeURIComponent(recommendationId)}/execution-plans/latest`,
      undefined,
      'GET',
    ))['executionPlan']);
    const fields = ['prerequisites', 'steps', 'validation', 'risks', 'rollback', 'successCriteria'];
    const text = content === undefined ? '' : JSON.stringify(content);
    const latencyMs = Date.now() - startedAt;
    const passed = planId !== undefined && latest?.['id'] === planId
      && executionPlan?.['auditVerdict'] === 'APPROVED'
      && typeof executionPlan['auditScore'] === 'number' && executionPlan['auditScore'] >= 80
      && content !== undefined && fields.every((key) => Array.isArray(content[key]) && (content[key] as unknown[]).length > 0)
      && looksLikeSpanish(text) && !containsAutoExecution(content) && latencyMs <= 120_000;
    return { passed, latencyMs, status: 200 };
  } catch (error) {
    return { passed: false, latencyMs: Date.now() - startedAt, status: statusFrom(error) };
  }
});

const checks = {
  chats: chatResults,
  recommendations: recommendationRuns,
  recommendationPreviewsDidNotPersist: beforeCount === afterCount,
  plans: planRuns,
};
const recommendationPassCount = recommendationRuns.filter((item) => item.passed).length;
const recommendationP95Ms = summarizeLatencies(recommendationRuns.map((item) => item.latencyMs)).p95;
const output = {
  success: chatResults.every((item) => item.passed)
    && recommendationPassCount >= 9
    && recommendationP95Ms <= 90_000
    && recommendationRuns.every((item) => item.latencyMs <= 120_000)
    && beforeCount === afterCount
    && planRuns.every((item) => item.passed)
    && generatedPlanIds.size === 5,
  generatedAt: new Date().toISOString(),
  providerModel: process.env['AI_EXPECTED_MODEL'] ?? 'gpt-5.6-luna',
  isolatedFixtureRunId: manifest.runId,
  metrics: {
    chatCount: chatResults.length,
    recommendationRuns: recommendationRuns.length,
    recommendationPasses: recommendationPassCount,
    executionPlanRuns: planRuns.length,
    executionPlanPasses: planRuns.filter((item) => item.passed).length,
    uniqueExecutionPlans: generatedPlanIds.size,
    chatLatencyMs: summarizeLatencies(chatResults.map((item) => item.latencyMs)),
    recommendationLatencyMs: summarizeLatencies(recommendationRuns.map((item) => item.latencyMs)),
    executionPlanLatencyMs: summarizeLatencies(planRuns.map((item) => item.latencyMs)),
    persistedRecommendationsBefore: beforeCount,
    persistedRecommendationsAfter: afterCount,
  },
  checks,
};
const outputFile = resolve(`.test-artifacts/ai-audit/deep-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await mkdir(resolve('.test-artifacts/ai-audit'), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...output, outputFile }, null, 2));
if (!output.success) process.exitCode = 1;

async function login(): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: manifest.admin.email, password: manifest.password }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function request(
  path: string,
  body: unknown,
  method = 'POST',
  retryAfterUnauthorized = true,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(125_000),
  });
  if (response.status === 401 && retryAfterUnauthorized) {
    token = await login();
    return request(path, body, method, false);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function recommendationCount(): Promise<number> {
  const result = await request('/recommendations', undefined, 'GET');
  return Array.isArray(result['recommendations']) ? result['recommendations'].length : 0;
}

function isAuditedRecommendation(recommendation: Record<string, unknown>): boolean {
  const evidence = asRecord(recommendation['evidence']);
  const audit = asRecord(evidence?.['aiAudit']);
  const maximumSavings = evidence?.['maxEstimatedMonthlySavings'];
  const savingsValues = ['estimatedMonthlySavings', 'potentialMonthlySavings']
    .map((key) => recommendation[key])
    .filter((value) => value !== undefined && value !== null);
  return evidence !== undefined && audit?.['verdict'] === 'APPROVED'
    && typeof audit['score'] === 'number' && audit['score'] >= 80
    && savingsValues.every((value) => typeof value === 'number' && Number.isFinite(value)
      && value >= 0 && typeof maximumSavings === 'number' && value <= maximumSavings);
}

async function sequentialRuns<T>(count: number, run: () => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  for (let index = 0; index < count; index += 1) results.push(await run());
  return results;
}

function summarizeLatencies(values: readonly number[]): { p50: number; p95: number; max: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return { p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? 0 };
}

function containsUnsafeMarkup(value: string): boolean {
  return /<\s*(script|img|iframe|object|svg)\b|javascript\s*:/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function statusFrom(error: unknown): number | undefined {
  const match = error instanceof Error ? error.message.match(/HTTP (\d{3})/) : undefined;
  return match === undefined || match === null ? undefined : Number(match[1]);
}
