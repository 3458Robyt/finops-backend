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

const chat = await post('/ai/chat', {
  message: 'Responde en una frase: cual es la principal oportunidad FinOps segun los datos disponibles?',
});
const chatAnswer = String(readJsonPath(chat, ['answer']) ?? '');
checks.push({
  name: 'chat_responde_en_espanol',
  passed: containsSpanishSignal(chatAnswer),
  detail: chatAnswer.slice(0, 300),
});

const recommendationStartedAt = Date.now();
const generatedResult = await postMaybe('/ai/recommendations/generate', { persist: false });
const recommendationLatencyMs = Date.now() - recommendationStartedAt;
checks.push({
  name: 'endpoint_recomendaciones_responde',
  passed: generatedResult.ok,
  detail: generatedResult.ok ? 'HTTP 200' : `HTTP ${generatedResult.status}: ${JSON.stringify(generatedResult.body).slice(0, 300)}`,
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

const traceResponse = await get('/agent/context-traces?limit=5');
const traces = Array.isArray(traceResponse['traces']) ? traceResponse['traces'] as Record<string, unknown>[] : [];
checks.push({
  name: 'registra_trazas_ia',
  passed: traces.some((trace) => trace['status'] === 'SUCCESS'),
  detail: JSON.stringify(traces.slice(0, 3)),
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
    traceLatencyMs,
    tokenEstimate,
    recommendationCount: recommendations.length,
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
  const bodyJson = text.trim().length > 0 ? JSON.parse(text) as Record<string, unknown> : {};
  return response.ok
    ? { ok: true, status: response.status, body: bodyJson }
    : { ok: false, status: response.status, body: bodyJson };
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
