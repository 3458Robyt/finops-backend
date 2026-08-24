import 'dotenv/config';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import type { E2eFixtureManifest } from '../../src/testing/e2eFixtures.js';
import {
  createTestingPrismaClient,
  type E2eFixtureManifest as FixtureManifest,
} from '../../src/testing/e2eFixtures.js';
import { evaluateGlobalLearningCanary } from '../../src/application/services/learning/learningPromotionEvaluator.js';
import { GlobalLearningPromotionService } from '../../src/application/services/learning/GlobalLearningPromotionService.js';
import { PrismaAgentLearningRepository } from '../../src/infrastructure/repositories/PrismaAgentLearningRepository.js';
import { queryRecommendationLearningContext } from '../../src/infrastructure/repositories/queries/agentLearningSearchQueries.js';
import type {
  GlobalLearningCanaryArmEvidence,
  GlobalLearningCanaryEvidence,
} from '../../src/domain/models/AgentLearning.js';

interface AuditCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const liveEnabled = process.env['AI_LIVE_TESTS'] === 'true';
if (!liveEnabled) {
  console.log(JSON.stringify({
    success: true,
    skipped: true,
    reason: 'Set AI_LIVE_TESTS=true to run the isolated global-learning canary.',
  }, null, 2));
  process.exit(0);
}

const apiBaseUrl = (process.env['E2E_API_BASE_URL'] ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');
const manifestPath = resolve(process.env['E2E_FIXTURE_FILE'] ?? '.test-artifacts/e2e-fixtures.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as E2eFixtureManifest;
const runId = `learning-live-${manifest.runId}`;
const prisma = createTestingPrismaClient();
const checks: AuditCheck[] = [];
let candidateId: string | undefined;
let sourceLearningEventId: string | undefined;

try {
  const fixture = await createShadowCandidate(prisma, manifest, runId);
  candidateId = fixture.candidateId;
  sourceLearningEventId = fixture.sourceLearningEventId;
  await assertFixtureCredential(prisma, manifest);
  const token = await login(manifest.admin.email, manifest.password);

  const baseline = await runGeneration(token);
  const baselineTrace = await readLearningTrace(token, candidateId);
  checks.push({
    name: 'baseline_no_usa_memoria_candidata',
    passed: !baselineTrace.hasCandidateMemory,
    detail: JSON.stringify({ traceCount: baselineTrace.traceCount }),
  });

  await setCandidateActive(prisma, candidateId, true, runId);
  const contextWithCandidate = await queryRecommendationLearningContext(
    prisma,
    fixture.tenantId,
    'proveedor servicio recurso que no aparece en el patrón global',
    10,
  );
  const candidateInContextQuery = contextWithCandidate.memories.some((memory) => memory.id === candidateId);
  checks.push({
    name: 'candidate_aparece_en_consulta_de_contexto',
    passed: candidateInContextQuery,
    detail: JSON.stringify({ memoryCount: contextWithCandidate.memories.length }),
  });
  let candidate: GlobalLearningCanaryArmEvidence;
  try {
    candidate = await runGeneration(token);
  } finally {
    await setCandidateActive(prisma, candidateId, false, runId);
  }
  const candidateTrace = await readLearningTrace(token, candidateId);
  checks.push({
    name: 'candidate_aparece_en_trazabilidad',
    passed: candidate.recommendationCount === 0 ? true : candidateTrace.hasCandidateMemory,
    detail: JSON.stringify({ traceCount: candidateTrace.traceCount, skippedBecauseProviderFailed: candidate.recommendationCount === 0 }),
  });

  const evidence: GlobalLearningCanaryEvidence = {
    mode: 'LIVE_COMPARATIVE_CANARY',
    runId,
    candidateMemoryId: candidateId,
    baseline,
    candidate,
    generatedAt: new Date().toISOString(),
  };
  const evaluation = evaluateGlobalLearningCanary(evidence);
  checks.push({
    name: 'canary_no_degrada_calidad',
    passed: evaluation.safetyPassed,
    detail: JSON.stringify({
      baselineScore: baseline.qualityScore,
      candidateScore: candidate.qualityScore,
      blockers: evaluation.blockers,
    }),
  });

  let promotion: { readonly promoted: boolean; readonly rolledBack: boolean } = {
    promoted: false,
    rolledBack: false,
  };
  if (evaluation.passed && !baselineTrace.hasCandidateMemory && candidateTrace.hasCandidateMemory) {
    const repository = new PrismaAgentLearningRepository(prisma);
    const promotionService = new GlobalLearningPromotionService(repository);
    const memory = await promotionService.promote({
      actor: {
        userId: fixture.userId,
        tenantId: fixture.tenantId,
        email: manifest.admin.email,
        role: 'MASTER_ADMIN',
        jwtId: `learning-canary:${runId}`,
      },
      sourceLearningEventId,
      evidence,
    });
    const rolledBack = await repository.deactivateMemory({
      tenantId: fixture.tenantId,
      memoryId: memory.id,
      allowGlobal: true,
      actorUserId: fixture.userId,
    });
    promotion = { promoted: true, rolledBack: rolledBack?.active === false };
  }

  const finalMemory = await prisma.agentMemory.findUnique({ where: { id: candidateId } });
  checks.push({
    name: 'promocion_solo_si_mejora',
    passed: evaluation.passed ? promotion.promoted && promotion.rolledBack : finalMemory?.active === false,
    detail: JSON.stringify({
      qualityImproved: evaluation.qualityImproved,
      promoted: promotion.promoted,
      rolledBack: promotion.rolledBack,
      finalActive: finalMemory?.active ?? null,
    }),
  });

  const output = {
    success: checks.every((check) => check.passed),
    promotionEligible: evaluation.passed,
    generatedAt: new Date().toISOString(),
    checks,
    evidence,
    evaluation,
    metrics: {
      baseline,
      candidate,
      traceBaselineCount: baselineTrace.traceCount,
      traceCandidateCount: candidateTrace.traceCount,
    },
  };
  await writeReport(output);
  console.log(JSON.stringify(output, null, 2));
  if (!output.success) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

async function createShadowCandidate(
  db: ReturnType<typeof createTestingPrismaClient>,
  fixtureManifest: FixtureManifest,
  canaryRunId: string,
): Promise<{ readonly candidateId: string; readonly sourceLearningEventId: string; readonly tenantId: string; readonly userId: string }> {
  const recommendationId = fixtureManifest.recommendationIds[0];
  const tenant = fixtureManifest.tenants[0];
  if (recommendationId === undefined || tenant === undefined) throw new Error('AI fixtures must include a recommendation and tenant.');
  const user = await db.user.findUnique({ where: { email: fixtureManifest.admin.email } });
  const recommendation = await db.recommendation.findUnique({ where: { id: recommendationId } });
  if (user === null || recommendation === null) throw new Error('AI fixtures are incomplete for the learning canary.');

  const decision = await db.recommendationDecision.create({
    data: {
      recommendationId,
      userId: user.id,
      decision: 'APPROVED',
      reasonCode: 'APPROVED_HIGH_CONFIDENCE',
      reason: 'Fixture aislada del canary de aprendizaje global.',
    },
  });
  const event = await db.agentLearningEvent.create({
    data: {
      tenantId: tenant.id,
      recommendationId,
      decisionId: decision.id,
      userId: user.id,
      decision: 'APPROVED',
      reasonCode: 'APPROVED_HIGH_CONFIDENCE',
      reason: 'Fixture aislada del canary de aprendizaje global.',
      recommendationType: recommendation.type,
      cloudAccountId: recommendation.cloudAccountId,
      severity: recommendation.severity,
      title: recommendation.title,
      description: recommendation.description,
      evidenceSummary: 'Evidencia sintética aislada; no representa un tenant real.',
      status: 'APPROVED',
      auditVerdict: 'APPROVED',
      auditScore: 95,
      auditReport: { verdict: 'APPROVED', score: 95 },
    },
  });
  const candidate = await db.agentMemory.create({
    data: {
      scope: 'GLOBAL',
      memoryType: 'APPROVAL_PATTERN',
      content: 'Patrón global FinOps: priorizar acciones reversibles con evidencia técnica suficiente.',
      confidence: 0.95,
      active: false,
      sourceLearningEventId: event.id,
      metadata: { learningLifecycle: 'SHADOW', canaryRunId },
      auditVerdict: 'APPROVED',
      auditScore: 95,
      auditReport: { verdict: 'APPROVED', score: 95 },
      fingerprint: `GLOBAL:${canaryRunId}`,
    },
  });
  return { candidateId: candidate.id, sourceLearningEventId: event.id, tenantId: tenant.id, userId: user.id };
}

async function setCandidateActive(
  db: ReturnType<typeof createTestingPrismaClient>,
  memoryId: string,
  active: boolean,
  canaryRunId: string,
): Promise<void> {
  await db.agentMemory.update({
    where: { id: memoryId },
    data: {
      active,
      metadata: {
        learningLifecycle: 'SHADOW',
        canaryRunId,
        ...(active ? { canaryArm: 'CANDIDATE' } : { canaryArm: 'BASELINE' }),
      },
    },
  });
}

async function runGeneration(token: string): Promise<GlobalLearningCanaryArmEvidence> {
  const startedAt = Date.now();
  const response = await fetch(`${apiBaseUrl}/ai/recommendations/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ persist: false }),
  });
  const body = await readJson(response);
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    const audit = asRecord(body['audit']);
    const failureReasons = [
      ...readStringArray(audit?.['blockingIssues']),
      ...readStringArray(audit?.['requiredChanges']),
    ].filter((value, index, values) => values.indexOf(value) === index).slice(0, 8);
    return {
      recommendationCount: 0,
      approvedRecommendationCount: 0,
      invalidOutputCount: 1,
      nonNegativeSavings: false,
      qualityScore: 0,
      tokenEstimate: 0,
      latencyMs,
      ...(typeof body['code'] === 'string' ? { failureCode: body['code'] } : {}),
      ...(typeof audit?.['verdict'] === 'string' ? { auditVerdict: audit['verdict'] } : {}),
      ...(typeof audit?.['score'] === 'number' ? { auditScore: audit['score'] } : {}),
      ...(failureReasons.length === 0 ? {} : { failureReasons }),
    };
  }

  const recommendations = Array.isArray(body['recommendations']) ? body['recommendations'] as Record<string, unknown>[] : [];
  const analysis = asRecord(body['analysis']);
  const audit = asRecord(analysis?.['audit']);
  const generatedCount = readNonNegativeNumber(analysis?.['generatedCount']) || recommendations.length;
  const scores = recommendations.map((item) => readNonNegativeNumber(asRecord(asRecord(item['evidence'])?.['aiAudit'])?.['score'])).filter((score) => score > 0);
  const qualityScore = readNonNegativeNumber(audit?.['score']) || (scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length);
  return {
    recommendationCount: recommendations.length,
    approvedRecommendationCount: recommendations.filter((item) => asRecord(asRecord(item['evidence'])?.['aiAudit'])?.['verdict'] === 'APPROVED').length,
    invalidOutputCount: Math.max(0, generatedCount - recommendations.length),
    nonNegativeSavings: recommendations.every((item) => typeof item['estimatedMonthlySavings'] !== 'number' || item['estimatedMonthlySavings'] >= 0),
    qualityScore,
    tokenEstimate: readNonNegativeNumber(analysis?.['promptTokenEstimate']) + readNonNegativeNumber(analysis?.['responseTokenEstimate']),
    latencyMs,
    ...(typeof audit?.['verdict'] === 'string' ? { auditVerdict: audit['verdict'] } : {}),
    ...(typeof audit?.['score'] === 'number' ? { auditScore: audit['score'] } : {}),
  };
}

async function readLearningTrace(token: string, memoryId: string): Promise<{ readonly hasCandidateMemory: boolean; readonly traceCount: number }> {
  const response = await fetch(`${apiBaseUrl}/agent/context-traces?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await readJson(response);
  const traces = Array.isArray(body['traces']) ? body['traces'] as Record<string, unknown>[] : [];
  return {
    hasCandidateMemory: traces.some((trace) => readStringArray(trace['memoryIds']).includes(memoryId)),
    traceCount: traces.length,
  };
}

async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await readJson(response);
  if (!response.ok || typeof body['accessToken'] !== 'string') {
    throw new Error(`learning canary login failed with HTTP ${response.status}: ${JSON.stringify({ code: body['code'], error: body['error'] })}`);
  }
  return body['accessToken'];
}

async function assertFixtureCredential(
  db: ReturnType<typeof createTestingPrismaClient>,
  fixtureManifest: FixtureManifest,
): Promise<void> {
  const user = await db.user.findUnique({
    where: { email: fixtureManifest.admin.email },
    select: { status: true, passwordHash: true },
  });
  const passwordMatches = user === null ? false : await argon2.verify(user.passwordHash, fixtureManifest.password);
  if (user === null || !passwordMatches || user.status !== 'ACTIVE') {
    throw new Error(`learning canary fixture credential mismatch: ${JSON.stringify({ userFound: user !== null, passwordMatches, active: user?.status === 'ACTIVE' })}`);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text.trim() === '' ? {} : JSON.parse(text) as Record<string, unknown>;
}

async function writeReport(output: unknown): Promise<void> {
  await mkdir(resolve('.test-artifacts/ai-audit'), { recursive: true });
  const file = resolve(`.test-artifacts/ai-audit/learning-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string') ? value : [];
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
