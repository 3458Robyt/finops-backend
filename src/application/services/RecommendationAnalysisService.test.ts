import { describe, expect, test, vi } from 'vitest';

import { AiAuditRejectedError, AuthorizationError } from '../../domain/errors/errors.js';
import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IProcessHeartbeatRepository } from '../../domain/interfaces/IProcessHeartbeatRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
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

  test('bloquea a clientes la lectura del readiness y del historial de gobierno del agente', async () => {
    const { service, repository, aiService } = createSubject();
    const client = { ...actor, role: 'CLIENT_VIEWER' as const };

    await expect(service.preview(client, {})).rejects.toBeInstanceOf(AuthorizationError);
    await expect(service.list(client)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(service.get(client, 'run-1')).rejects.toBeInstanceOf(AuthorizationError);

    expect(aiService.prepareRecommendationAnalysis).not.toHaveBeenCalled();
    expect(repository.listByTenant).not.toHaveBeenCalled();
    expect(repository.findById).not.toHaveBeenCalled();
  });

  test('permite a un técnico FinOps consultar readiness e historial del agente', async () => {
    const { service, repository } = createSubject();
    const technician = { ...actor, role: 'FINOPS_TECHNICIAN' as const };

    await expect(service.preview(technician, {})).resolves.toMatchObject({
      scope: 'TENANT',
      resourcesEvaluated: 0,
    });
    await expect(service.list(technician)).resolves.toEqual([]);
    await expect(service.get(technician, 'run-1')).resolves.toBeNull();

    expect(repository.listByTenant).toHaveBeenCalledWith(technician.tenantId, undefined);
    expect(repository.findById).toHaveBeenCalledWith(technician.tenantId, 'run-1');
  });

  test('no encola una corrida cuando el worker no tiene heartbeat vigente', async () => {
    const { service, repository } = createSubject(buildPrepared([], []), {
      findFreshByRoles: vi.fn(async () => null),
    });

    await expect(service.queue(actor, {})).rejects.toMatchObject({
      code: 'RECOMMENDATION_ANALYSIS_WORKER_UNAVAILABLE',
    });
    expect(repository.queue).not.toHaveBeenCalled();
  });

  test('solicita la cancelación de una corrida que ya está en ejecución', async () => {
    const running = buildRun({ status: 'RUNNING', stage: 'AI_GENERATION' });
    const { service, repository } = createSubject();
    vi.mocked(repository.requestCancellation).mockResolvedValueOnce(running);

    const result = await service.cancel(actor, running.id);

    expect(result).toBe(running);
    expect(repository.requestCancellation).toHaveBeenCalledWith(
      actor.tenantId,
      running.id,
      expect.any(Date),
    );
  });

  test('omite la IA cuando la compuerta no encuentra evidencia suficiente', async () => {
    const prepared = buildPrepared([], [buildCandidate('BLOCKED_NO_EVIDENCE')]);
    const { service, repository, aiService } = createSubject(prepared);

    const result = await service.processNext('worker-1');

    expect(result?.status).toBe('SKIPPED');
    expect(aiService.generateRecommendations).not.toHaveBeenCalled();
    expect(aiService.generateRecommendationReviewDrafts).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'SKIPPED',
        errorCode: 'INSUFFICIENT_EVIDENCE',
        recommendationsGenerated: 0,
      }),
    );
  });

  test('guarda borradores técnicos auditados sin publicarlos ni contarlos como recomendaciones', async () => {
    const reviewCandidate = {
      ...buildCandidate('VALIDATION_ONLY'),
      observedCost: 120,
      evidenceIssues: [{ code: 'MISSING_MEMORY_METRIC', action: 'Verificar la telemetría de memoria.' }],
    };
    const base = buildPrepared([], [reviewCandidate]);
    const prepared = {
      ...base,
      readinessReport: { ...base.readinessReport, reviewCandidates: [reviewCandidate] },
    };
    const { service, repository, aiService } = createSubject(prepared);
    const draft = {
      cloudAccountId: 'account-1',
      type: 'TECHNICAL_VALIDATION_REQUIRED',
      severity: 'LOW',
      title: 'Validar telemetría de memoria',
      description: 'Confirmar que Monitoring emita la métrica para esta instancia.',
      currency: 'USD',
      evidence: { candidateId: reviewCandidate.id, requiresTechnicalValidation: true },
    };
    vi.mocked(aiService.generateRecommendationReviewDrafts).mockResolvedValueOnce({
      drafts: [{ ...draft, tenantId: actor.tenantId }],
      approvedDrafts: [{ ...draft, tenantId: actor.tenantId }],
      rejectedDrafts: [],
      candidateAudits: [{
        audit: { index: 0, candidateId: reviewCandidate.id, verdict: 'APPROVED', score: 95, checks: [], blockingIssues: [], requiredChanges: [] },
        draft,
        deterministicEvidence: draft.evidence,
      }],
      firstRawResponse: '{}',
      promptTokenEstimate: 300,
      responseTokenEstimate: 100,
      model: 'generator-test',
      auditorModel: 'auditor-test',
    });

    const result = await service.processNext('worker-1');

    expect(result?.status).toBe('COMPLETED');
    expect(aiService.generateRecommendations).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 'COMPLETED',
      recommendationsGenerated: 0,
      recommendationsRejected: 0,
      recommendationLinks: [],
      candidateAudits: [expect.objectContaining({
        candidateId: reviewCandidate.id,
        finalDisposition: 'REVIEW_DRAFT',
        auditVerdict: 'APPROVED',
      })],
      candidateResults: [expect.objectContaining({ outcome: 'REVIEW_DRAFT' })],
    }));
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
          model: 'generator-test',
          auditorModel: 'auditor-test',
          candidateAudits: [{
            index: 0,
            candidateId: candidate.id,
            verdict: 'REJECTED',
            score: 42,
            checks: [],
            blockingIssues: ['El ahorro excede la evidencia disponible.'],
            requiredChanges: [],
            draft: { evidence: { candidateId: candidate.id }, title: 'Draft auditado' },
          }],
          model: 'generator-test',
          auditorModel: 'auditor-test',
          candidateAudits: [{
            index: 0,
            candidateId: candidate.id,
            verdict: 'REJECTED',
            score: 42,
            checks: [],
            blockingIssues: ['El ahorro excede la evidencia disponible.'],
            requiredChanges: [],
            draft: { evidence: { candidateId: candidate.id }, title: 'Draft auditado' },
          }],
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
        candidateAudits: [expect.objectContaining({
          candidateId: candidate.id,
          draft: expect.objectContaining({ title: 'Draft auditado' }),
          finalDisposition: 'REJECTED',
        })],
        candidateAudits: [expect.objectContaining({
          candidateId: candidate.id,
          draft: expect.objectContaining({ title: 'Draft auditado' }),
          finalDisposition: 'REJECTED',
        })],
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

  test('no publica recomendaciones si se solicita cancelar después de la IA', async () => {
    const prepared = buildPrepared([buildCandidate('GENERATABLE')], []);
    const { service, repository, aiService, recommendationRepository } = createSubject(prepared, undefined, {
      createMany: vi.fn(async () => []),
    } as unknown as IRecommendationRepository);
    vi.mocked(repository.isCancellationRequested)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.mocked(repository.finalizeCancellation).mockResolvedValueOnce(
      buildRun({ status: 'CANCELLED', stage: 'FINISHED' }),
    );
    vi.mocked(aiService.generateRecommendations).mockResolvedValueOnce({
      recommendations: [{
        id: 'rec-ephemeral',
        cloudAccountId: 'account-1',
        type: 'RIGHTSIZING',
        status: 'PENDING',
        severity: 'MEDIUM',
        title: 'Validar dimensionamiento',
        description: 'Fixture efímero',
        evidence: { candidateId: 'candidate-1' },
        estimatedMonthlySavings: 10,
        currency: 'USD',
        createdAt: new Date('2026-07-23T00:00:00.000Z'),
        updatedAt: new Date('2026-07-23T00:00:00.000Z'),
      }],
      snapshot: prepared.snapshot,
      persisted: false,
      analysis: {
        readinessReport: prepared.readinessReport,
        evidenceHash: prepared.evidenceHash,
        generatedCount: 1,
        rejectedCount: 0,
        promptTokenEstimate: 100,
        responseTokenEstimate: 50,
        model: prepared.model,
        auditorModel: prepared.auditorModel,
      },
    });

    const result = await service.processNext('worker-1');

    expect(result?.status).toBe('CANCELLED');
    expect(recommendationRepository.createMany).not.toHaveBeenCalled();
    expect(repository.finalizeCancellation).toHaveBeenCalledWith('run-1');
  });
});

function createSubject(
  prepared = buildPrepared([], []),
  processHeartbeatRepository?: { readonly findFreshByRoles: ReturnType<typeof vi.fn> },
  recommendationRepository?: IRecommendationRepository,
) {
  const running = buildRun({ status: 'RUNNING', stage: 'SELECTING_DATA', attempts: 1 });
  const repository = {
    queue: vi.fn(async () => ({ run: buildRun(), reused: false })),
    findById: vi.fn(async () => null),
    listByTenant: vi.fn(async () => []),
    cancelPending: vi.fn(async () => null),
    requestCancellation: vi.fn(async () => null),
    isCancellationRequested: vi.fn(async () => false),
    finalizeCancellation: vi.fn(async () => null),
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
    generateRecommendationReviewDrafts: vi.fn(),
  } as unknown as FinOpsAiService;
  const notifications = {
    create: vi.fn(),
  } as unknown as INotificationRepository;

  return {
    repository,
    aiService,
    notifications,
    recommendationRepository,
    service: new RecommendationAnalysisService(
      repository,
      aiService,
      notifications,
      recommendationRepository,
      processHeartbeatRepository as IProcessHeartbeatRepository | undefined,
    ),
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
    readinessReport: { candidates, blocked, deferred: [], reviewCandidates: [], summary: 'fixture' },
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
