import 'dotenv/config';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { E2eFixtureManifest } from '../../src/testing/e2eFixtures.js';

interface AuditCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const apiBaseUrl = (process.env['E2E_API_BASE_URL'] ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');
const liveEnabled = process.env['AI_LIVE_TESTS'] === 'true';

if (!liveEnabled) {
  console.log(JSON.stringify({
    success: true,
    skipped: true,
    reason: 'Set AI_LIVE_TESTS=true to run live provider checks.',
  }, null, 2));
  process.exit(0);
}

const manifest = JSON.parse(await readFile(resolve(process.env['E2E_FIXTURE_FILE'] ?? '.test-artifacts/e2e-fixtures.json'), 'utf8')) as E2eFixtureManifest;
const token = await login(manifest.admin.email, manifest.password);
const checks: AuditCheck[] = [];
const expectedModel = process.env['AI_EXPECTED_MODEL'] ?? 'gpt-5.6-luna';

const chat = await post('/ai/chat', {
  message: 'Responde en una frase: cual es la principal oportunidad FinOps segun los datos disponibles?',
});
const chatAnswer = String(readJsonPath(chat, ['answer']) ?? '');
checks.push({
  name: 'chat_responde_en_espanol',
  passed: containsSpanishSignal(chatAnswer),
  detail: chatAnswer.slice(0, 300),
});

const formattedChat = await post('/ai/chat', {
  message: 'Responde con un encabezado breve y dos viñetas Markdown: ¿cuál es la principal oportunidad según los datos? No inventes datos.',
});
const formattedChatAnswer = String(readJsonPath(formattedChat, ['answer']) ?? '');
checks.push({
  name: 'chat_formato_markdown_seguro',
  passed: containsSpanishSignal(formattedChatAnswer) && !containsUnsafeMarkup(formattedChatAnswer),
  detail: formattedChatAnswer.slice(0, 500),
});

const unsupportedTechnicalChat = await post('/ai/chat', {
  message: '¿Cuál es el p95 de CPU y memoria de este tenant? Responde solo si existe evidencia técnica.',
});
const unsupportedTechnicalAnswer = String(readJsonPath(unsupportedTechnicalChat, ['answer']) ?? '');
checks.push({
  name: 'chat_no_inventa_metricas_tecnicas',
  passed: containsSpanishSignal(unsupportedTechnicalAnswer) && !containsUnsupportedTechnicalClaim(unsupportedTechnicalAnswer),
  detail: unsupportedTechnicalAnswer.slice(0, 500),
});

const recommendationStartedAt = Date.now();
const generatedResult = await postMaybe('/ai/recommendations/generate', { persist: false });
const recommendationLatencyMs = Date.now() - recommendationStartedAt;
checks.push({
  name: 'endpoint_recomendaciones_responde',
  passed: generatedResult.ok,
  detail: generatedResult.ok ? 'HTTP 200' : JSON.stringify({
    status: generatedResult.status,
    ...summarizeAiFailure(generatedResult.body),
  }),
});
const generated = generatedResult.ok ? generatedResult.body : {};
const recommendations = Array.isArray(generated['recommendations']) ? generated['recommendations'] as Record<string, unknown>[] : [];
checks.push({
  name: 'genera_recomendaciones',
  passed: recommendations.length > 0,
  detail: `Cantidad: ${recommendations.length}`,
});
checks.push({
  name: 'recomendaciones_tienen_evidencia',
  passed: recommendations.every((recommendation) => typeof recommendation['evidence'] === 'object' && recommendation['evidence'] !== null),
  detail: JSON.stringify(recommendations.map((recommendation) => recommendation['evidence']).slice(0, 2)),
});
checks.push({
  name: 'recomendaciones_guardan_snapshot_y_auditoria',
  passed: recommendations.every((recommendation) => {
    const evidence = asRecord(recommendation['evidence']);
    const technicalSnapshot = asRecord(evidence?.['recommendationEvidenceSnapshot']);
    const audit = asRecord(evidence?.['aiAudit']);
    return technicalSnapshot === undefined ||
      (typeof technicalSnapshot['hash'] === 'string' && audit?.['verdict'] === 'APPROVED');
  }),
  detail: JSON.stringify(recommendations.map((recommendation) => {
    const evidence = asRecord(recommendation['evidence']);
    return {
      snapshotHash: asRecord(evidence?.['recommendationEvidenceSnapshot'])?.['hash'],
      auditorVerdict: asRecord(evidence?.['aiAudit'])?.['verdict'],
    };
  })),
});
checks.push({
  name: 'no_inventa_ahorro_negativo',
  passed: recommendations.every((recommendation) => {
    const savings = recommendation['estimatedMonthlySavings'];
    return typeof savings !== 'number' || savings >= 0;
  }),
  detail: JSON.stringify(recommendations.map((recommendation) => recommendation['estimatedMonthlySavings'])),
});

const recommendationId = manifest.recommendationIds[0];
const latestPlanPath = recommendationId === undefined
  ? undefined
  : '/recommendations/' + encodeURIComponent(recommendationId) + '/execution-plans/latest';
const latestPlanBeforeResult = latestPlanPath === undefined
  ? { ok: false as const, status: 0, body: {} }
  : await getMaybe(latestPlanPath);
const latestPlanBefore = latestPlanBeforeResult.ok
  ? asRecord(latestPlanBeforeResult.body['executionPlan'])
  : undefined;
const planStartedAt = Date.now();
const planPath = recommendationId === undefined
  ? undefined
  : '/recommendations/' + encodeURIComponent(recommendationId) + '/execution-plan';
const planResult = planPath === undefined
  ? { ok: false as const, status: 0, body: {} }
  : await postMaybe(planPath, {});
const planLatencyMs = Date.now() - planStartedAt;
checks.push({
  name: 'endpoint_plan_ejecucion_responde',
  passed: planResult.ok,
  detail: planResult.ok ? 'HTTP 200' : JSON.stringify({
    status: planResult.status,
    ...summarizeAiFailure(planResult.body),
  }),
});
const executionPlan = planResult.ok ? asRecord(planResult.body['executionPlan']) : undefined;
const planContent = asRecord(executionPlan?.['content']);
const planAudit = asRecord(executionPlan?.['auditReport']);
const requiredPlanArrays = ['prerequisites', 'steps', 'validation', 'risks', 'rollback', 'successCriteria'];
checks.push({
  name: 'plan_tiene_estructura_manual_y_en_espanol',
  passed: planContent !== undefined
    && requiredPlanArrays.every((field) => Array.isArray(planContent[field]) && (planContent[field] as unknown[]).length > 0)
    && containsSpanishSignal(JSON.stringify(planContent))
    && !/(ejecutará automáticamente|ejecución automática|ejecutar automáticamente)/i.test(JSON.stringify(planContent)),
  detail: JSON.stringify({
    fields: requiredPlanArrays.map((field) => ({ field, present: Array.isArray(planContent?.[field]) })),
    auditVerdict: executionPlan?.['auditVerdict'],
    auditScore: executionPlan?.['auditScore'],
  }),
});
checks.push({
  name: 'plan_aprobado_por_auditor',
  passed: executionPlan?.['auditVerdict'] === 'APPROVED'
    && planAudit?.['verdict'] === 'APPROVED'
    && readNonNegativeNumber(executionPlan?.['auditScore']) >= 80,
  detail: JSON.stringify({ verdict: executionPlan?.['auditVerdict'], score: executionPlan?.['auditScore'] }),
});

const latestPlanResult = latestPlanPath === undefined
  ? { ok: false as const, status: 0, body: {} }
  : await getMaybe(latestPlanPath);
const latestPlan = latestPlanResult.ok ? asRecord(latestPlanResult.body['executionPlan']) : undefined;
const generatedPlanId = typeof executionPlan?.['id'] === 'string' ? executionPlan['id'] : undefined;
const latestPlanId = typeof latestPlan?.['id'] === 'string' ? latestPlan['id'] : undefined;
checks.push({
  name: 'plan_persistido_y_recuperable',
  passed: planResult.ok
    && latestPlanResult.ok
    && latestPlan !== undefined
    && latestPlan['recommendationId'] === recommendationId
    && generatedPlanId !== undefined
    && latestPlanId === generatedPlanId,
  detail: JSON.stringify({
    status: latestPlanResult.status,
    recommendationId: latestPlan?.['recommendationId'],
    expectedRecommendationId: recommendationId,
    generatedPlanId,
    latestPlanId,
  }),
});
checks.push({
  name: 'plan_rechazado_no_se_persistio',
  passed: planResult.ok || (
    planResult.body['code'] === 'AI_AUDIT_REJECTED'
    && latestPlanResult.ok
    && latestPlanId === (typeof latestPlanBefore?.['id'] === 'string' ? latestPlanBefore['id'] : undefined)
  ),
  detail: JSON.stringify({
    planStatus: planResult.status,
    planCode: planResult.body['code'],
    previousPlanId: latestPlanBefore?.['id'],
    latestPlanId,
  }),
});

const traceResponse = await get('/agent/context-traces?limit=5');
const traces = Array.isArray(traceResponse['traces']) ? traceResponse['traces'] as Record<string, unknown>[] : [];
checks.push({
  name: 'registra_trazas_ia',
  passed: traces.some((trace) => trace['status'] === 'SUCCESS'),
  detail: JSON.stringify(traces.slice(0, 3)),
});
checks.push({
  name: 'usa_modelo_esperado',
  passed: traces.some((trace) => trace['status'] === 'SUCCESS' && trace['model'] === expectedModel),
  detail: `Modelo esperado: ${expectedModel}; modelos observados: ${JSON.stringify([...new Set(traces.map((trace) => trace['model']))])}`,
});

const tokenEstimate = traces.reduce((total, trace) => (
  total + readNonNegativeNumber(trace['promptTokenEstimate']) + readNonNegativeNumber(trace['responseTokenEstimate'])
), 0);
const traceLatencyMs = traces.reduce((total, trace) => total + readNonNegativeNumber(trace['latencyMs']), 0);

const passed = checks.every((check) => check.passed);
const output = {
  success: passed,
  generatedAt: new Date().toISOString(),
  apiBaseUrl,
  metrics: {
    recommendationLatencyMs,
    planLatencyMs,
    traceLatencyMs,
    tokenEstimate,
    recommendationCount: recommendations.length,
    expectedModel,
  },
  checks,
};
await mkdir(resolve('.test-artifacts/ai-audit'), { recursive: true });
const outputFile = resolve(`.test-artifacts/ai-audit/${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({ ...output, outputFile }, null, 2));
if (!passed) {
  process.exitCode = 1;
}

async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(`login failed with HTTP ${response.status}`);
  }
  return ((await response.json()) as { readonly accessToken: string }).accessToken;
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as Record<string, unknown>;
}

async function postMaybe(
  path: string,
  body: unknown,
): Promise<{ readonly ok: true; readonly status: number; readonly body: Record<string, unknown> } | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const bodyJson = parseResponseRecord(text);
  return response.ok
    ? { ok: true, status: response.status, body: bodyJson }
    : { ok: false, status: response.status, body: bodyJson };
}

async function getMaybe(
  path: string,
): Promise<{ readonly ok: true; readonly status: number; readonly body: Record<string, unknown> } | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(apiBaseUrl + path, {
    headers: {
      Authorization: 'Bearer ' + token,
    },
  });
  const text = await response.text();
  const body = parseResponseRecord(text);
  return response.ok
    ? { ok: true, status: response.status, body }
    : { ok: false, status: response.status, body };
}

async function get(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as Record<string, unknown>;
}

function readJsonPath(value: Record<string, unknown>, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (typeof current !== 'object' || current === null || !Object.prototype.hasOwnProperty.call(current, key)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, value);
}

function containsSpanishSignal(text: string): boolean {
  const normalized = text.toLowerCase();
  return ['costo', 'ahorro', 'oportunidad', 'recomendacion', 'recomendación', 'segun', 'según'].some((word) => normalized.includes(word));
}

function containsUnsafeMarkup(text: string): boolean {
  return /<\s*(script|img|iframe|object|svg)\b|javascript\s*:/i.test(text);
}

function containsUnsupportedTechnicalClaim(text: string): boolean {
  return /\b(?:p95|cpu|memoria|iops|throughput)\b\s*(?:=|:|es|fue|alcanz[oó]|promedio|al)\s*\d+(?:[.,]\d+)?\s*%?/i.test(text);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseResponseRecord(text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed) ?? { error: 'The endpoint returned a non-object JSON response.' };
  } catch {
    return { error: text.slice(0, 300) };
  }
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function summarizeAiFailure(body: Record<string, unknown>): Record<string, unknown> {
  const audit = asRecord(body['audit']);
  return {
    error: body['error'],
    code: body['code'],
    diagnosticId: body['diagnosticId'],
    ...(audit === undefined ? {} : { audit }),
  };
}
