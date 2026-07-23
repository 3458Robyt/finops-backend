import { describe, expect, test, vi } from 'vitest';

import { AiAuditRejectedError, AuthorizationError } from '../../domain/errors/errors.js';
import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IRecommendationAnalysisRunRepository } from '../../domain/interfaces/IRecommendationAnalysisRunRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { RecommendationAnalysisRun } from '../../domain/models/RecommendationAnalysisRun.js';
import type { FinOpsAiService } from './FinOpsAiService.js';
import { RecommendationAnalysisService } from './RecommendationAnalysisService.js';
import type { PreparedRecommendationAnalysis } from './ai/finOpsAiTypes.js';
import type { RecommendationOpportunityCandidate } from './ai/RecommendationReadinessGate.js';

const actor: AuthContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  email: 'admin@example.com',
  role: 'ADMIN',
  jwtId: 'jwt-1',
};

describe('RecommendationAnalysisService', () => {
  test('impide disparar análisis a roles de solo lectura', async () => {
    const { service } = createSubject();

    await expect(service.queue({ ...actor, role: 'CLIENT_VIEWER' }, {}))
      .rejects.toBeInstanceOf(AuthorizationError);
  });

  test('omite la IA cuando la compuerta no encuentra evidencia suficiente', async () => {
    const prepared = buildPrepared([], [buildCandidate('BLOCKED_NO_EVIDENCE')]);
    const { service, repository, aiService } = createSubject(prepared);

    const result = await service.processNext('worker-1');

    expect(result?.status).toBe('SKIPPED');
    expect(aiService.generateRecommendations).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'SKIPPED',
        errorCode: 'INSUFFICIENT_EVIDENCE',
        recommendationsGenerated: 0,
      }),
    );
  });

  test('no repite una corrida cuando período y evidencia ya fueron procesados', async () => {
    const prepared = buildPrepared([buildCandidate('GENERATABLE')], []);
    const { service, repository, aiService } = createSubject(prepared);
    vi.mocked(repository.findEquivalentCompleted).mockResolvedValueOnce(
      buildRun({ id: 'run-anterior', status: 'COMPLETED' }),
    );

    const result = await service.processNext('worker-1');

    expect(result?.errorCode).toBe('UNCHANGED_EVIDENCE');
    expect(aiService.generateRecommendations).not.toHaveBeenCalled();
  });

  test('conserva el rechazo del auditor y no publica recomendaciones', async () => {
    const candidate = buildCandidate('GENERATABLE');
    const prepared = buildPrepared([candidate], []);
    const { service, repository, aiService } = createSubject(prepared);
    vi.mocked(aiService.generateRecommendations).mockRejectedValueOnce(
      new AiAuditRejectedError('rechazado', {
        diagnosticId: 'audit-1',
        audit: {
          generatedCount: 1,
          blockingIssues: ['El ahorro excede la evidencia disponible.'],
          candidates: [candidate],
        },
      }),
    );

    const result = await service.processNext('worker-1');

    expect(result?.status).toBe('PARTIAL');
    expect(repository.complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'PARTIAL',
        recommendationsRejected: 1,
        recommendationLinks: [],
        errorCode: 'AI_AUDIT_REJECTED',
      }),
    );
  });

  test.each(['Request timed out.', 'Unexpected token in JSON'])(
    'registra un fallo temporal seguro y reanudable: %s',
    async (providerMessage) => {
      const prepared = buildPrepared([buildCandidate('GENERATABLE')], []);
      const { service, repository, aiService } = createSubject(prepared);
      vi.mocked(aiService.generateRecommendations).mockRejectedValueOnce(new Error(providerMessage));

      const result = await service.processNext('worker-1');

      expect(result?.status).toBe('PENDING');
      expect(repository.recordFailure).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          code: 'ANALYSIS_PROVIDER_ERROR',
          message: expect.not.stringContaining(providerMessage),
          retryAt: expect.any(Date),
        }),
      );
    },
  );

  test('reanuda sin duplicar una recomendación persistida antes del fallo', async () => {
    const prepared = buildPrepared([buildCandidate('GENERATABLE')], []);
    const { service, repository, aiService, notifications } = createSubject(prepared);
    vi.mocked(aiService.generateRecommendations).mockResolvedValueOnce({
      recommendations: [{
        id: 'rec-existing',
        cloudAccountId: 'account-1',
        type: 'RIGHTSIZING',
        status: 'PENDING',
        severity: 'MEDIUM',
        title: 'Validar dimensionamiento',
        description: 'Fixture',
        evidence: { candidateId: 'candidate-1' },
        estimatedMonthlySavings: 10,
        currency: 'USD',
        createdAt: new Date('2026-07-22T00:00:00.000Z'),
        updatedAt: new Date('2026-07-22T00:00:00.000Z'),
      }],
      snapshot: prepared.snapshot,
      persisted: true,
      analysis: {
        readinessReport: prepared.readinessReport,
        evidenceHash: prepared.evidenceHash,
        generatedCount: 1,
        promptTokenEstimate: 100,
        responseTokenEstimate: 50,
        model: prepared.model,
        auditorModel: prepared.auditorModel,
      },
    });

    const result = await service.processNext('worker-1');

    expect(result?.status).toBe('COMPLETED');
    expect(repository.complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        recommendationLinks: [expect.objectContaining({
          recommendationId: 'rec-existing',
          disposition: 'REUSED',
        })],
      }),
    );
    expect(notifications.create).not.toHaveBeenCalled();
  });
});

function createSubject(prepared = buildPrepared([], [])) {
  const running = buildRun({ status: 'RUNNING', stage: 'SELECTING_DATA', attempts: 1 });
  const repository = {
    queue: vi.fn(async () => ({ run: buildRun(), reused: false })),
    findById: vi.fn(async () => null),
    listByTenant: vi.fn(async () => []),
    cancelPending: vi.fn(async () => null),
    retryFailed: vi.fn(async () => null),
    claimNext: vi.fn(async () => running),
    updateStage: vi.fn(async () => undefined),
    savePrepared: vi.fn(async () => undefined),
    findEquivalentCompleted: vi.fn(async () => null),
    complete: vi.fn(async (_runId, input) => buildRun({
      status: input.status,
      stage: 'FINISHED',
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      candidateResults: input.candidateResults,
      recommendationsGenerated: input.recommendationsGenerated,
      recommendationsRejected: input.recommendationsRejected,
      recommendationsPersisted: input.recommendationLinks.length,
    })),
    recordFailure: vi.fn(async () => buildRun({ status: 'PENDING', errorCode: 'TEMPORARY_ERROR' })),
  } as unknown as IRecommendationAnalysisRunRepository;
  const aiService = {
    prepareRecommendationAnalysis: vi.fn(async () => prepared),
    generateRecommendations: vi.fn(),
  } as unknown as FinOpsAiService;
  const notifications = {
    create: vi.fn(),
  } as unknown as INotificationRepository;

  return {
    repository,
    aiService,
    notifications,
    service: new RecommendationAnalysisService(repository, aiService, notifications),
  };
}

function buildPrepared(
  candidates: readonly RecommendationOpportunityCandidate[],
  blocked: readonly RecommendationOpportunityCandidate[],
): PreparedRecommendationAnalysis {
  return {
    snapshot: {
      tenantId: 'tenant-1',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'USD',
      metricCount: 10,
      providers: [],
      accounts: [],
      services: [],
      environments: [],
      topResources: [],
      topUsage: [],
    },
    readinessReport: { candidates, blocked, deferred: [], summary: 'fixture' },
    evidenceHash: 'evidence-1',
    deterministicAnalysis: {
      cost: null,
      usageByUnit: [],
      costMonths: 0,
      usageMonths: 0,
      signals: ['INSUFFICIENT_COST_TREND_HISTORY', 'INSUFFICIENT_USAGE_TREND_HISTORY'],
    },
    model: 'generator-test',
    auditorModel: 'auditor-test',
  };
}

function buildCandidate(
  readiness: RecommendationOpportunityCandidate['readiness'],
): RecommendationOpportunityCandidate {
  return {
    id: 'candidate-1',
    readiness,
    cloudAccountId: 'account-1',
    provider: 'OCI',
    serviceName: 'Compute',
    resourceId: 'instance-1',
    opportunityType: 'RIGHTSIZING',
    evidenceLevelAllowed: readiness === 'GENERATABLE' ? 'COST_USAGE_AND_TECHNICAL' : 'COST_ONLY',
    requiresTechnicalValidation: readiness !== 'GENERATABLE',
    maxEstimatedMonthlySavings: 10,
    currency: 'USD',
    sourceFacts: ['fixture'],
    technicalEvidenceRefs: [],
    reasons: ['fixture'],
    forbiddenClaims: [],
  };
}

function buildRun(
  overrides: Partial<RecommendationAnalysisRun> = {},
): RecommendationAnalysisRun {
  const now = new Date('2026-07-23T00:00:00.000Z');
  return {
    id: 'run-1',
    tenantId: 'tenant-1',
    requestedByUserId: 'user-1',
    trigger: 'MANUAL',
    scope: 'TENANT',
    scopeKey: '__tenant__',
    status: 'PENDING',
    stage: 'QUEUED',
    attempts: 0,
    maxAttempts: 2,
    resourcesEvaluated: 0,
    candidatesFound: 0,
    candidatesSkipped: 0,
    recommendationsGenerated: 0,
    recommendationsRejected: 0,
    recommendationsPersisted: 0,
    promptTokenEstimate: 0,
    responseTokenEstimate: 0,
    createdAt: now,
    updatedAt: now,
    recommendations: [],
    ...overrides,
  };
}
