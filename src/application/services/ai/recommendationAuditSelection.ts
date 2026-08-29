import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type {
  AiAuditCheck,
  AiAuditReport,
  AiCandidateAudit,
} from '../../../domain/models/RecommendationExecutionPlan.js';
import { readCandidateId } from '../recommendationAnalysisSupport.js';
import type { AiRecommendationDraft } from './finOpsAiTypes.js';
import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import { evaluateRecommendationDrafts } from './evaluation/recommendationQualityChecks.js';

export interface AuditedRecommendationSelection {
  readonly accepted: readonly AiRecommendationDraft[];
  readonly rejected: readonly AiRecommendationDraft[];
  readonly candidateAudits: readonly AiCandidateAudit[];
}

/**
 * Aplica la política de auditoría a cada draft, no al lote completo.
 *
 * El auditor puede devolver un informe legado sin `candidateAudits`; en ese
 * caso solo un lote global aprobado es elegible. Cuando existe auditoría por
 * candidato, una salida rechazada no arrastra a las demás, pero los controles
 * deterministas siempre se evalúan nuevamente de forma individual.
 */
export function selectAuditedRecommendationDrafts(input: {
  readonly drafts: readonly AiRecommendationDraft[];
  readonly auditReport: AiAuditReport;
  readonly snapshot: CostAnalyticsSnapshot;
  readonly externalResourceId?: string;
  readonly technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot;
}): AuditedRecommendationSelection {
  const hasItemAudits = (input.auditReport.candidateAudits?.length ?? 0) > 0;
  const candidateAudits = input.drafts.map((draft, index) => {
    const candidateId = readCandidateId(draft.evidence) ?? `draft-${index}`;
    const supplied = input.auditReport.candidateAudits?.find((audit) => (
      audit.index === index
      && (audit.candidateId === undefined || audit.candidateId === candidateId)
    ));
    const quality = evaluateRecommendationDrafts(
      [draft],
      input.snapshot,
      undefined,
      input.externalResourceId,
      input.technicalEvidenceSnapshot,
    );
    const qualityChecks: AiAuditCheck[] = quality.checks.map((check) => ({
      name: `deterministic:${check.name}`,
      passed: check.passed,
      notes: check.detail,
    }));
    const aiVerdict = supplied?.verdict ?? input.auditReport.verdict;
    const aiScore = supplied?.score ?? input.auditReport.score;
    const aiChecks = supplied?.checks ?? input.auditReport.checks;
    const aiBlockingIssues = supplied?.blockingIssues ?? [];
    const aiRequiredChanges = supplied?.requiredChanges ?? [];
    const globalIssues = globalIssuesForItem(input.auditReport, index, hasItemAudits);
    // Los auditores actuales deben devolver auditorías por candidato con IDs
    // explícitos. Conservamos compatibilidad con el formato legado de auditoría
    // global, que no podía identificar candidatos individualmente.
    const missingCandidateId = hasItemAudits && readCandidateId(draft.evidence) === undefined;
    const blockingIssues = [
      ...aiBlockingIssues,
      ...globalIssues,
      ...(missingCandidateId ? ['El borrador no identifica un candidato autorizado.'] : []),
      ...qualityChecks.filter((check) => !check.passed).map((check) => check.notes),
    ];
    const requiredChanges = [
      ...aiRequiredChanges,
      ...qualityChecks.filter((check) => !check.passed).map((check) => check.notes),
    ];
    const approved = aiVerdict === 'APPROVED'
      && aiScore >= 80
      && aiChecks.every((check) => check.passed)
      && blockingIssues.length === 0
      && requiredChanges.length === 0
      && quality.passed;
    const audit: AiCandidateAudit = {
      index,
      candidateId,
      verdict: approved ? 'APPROVED' : 'REJECTED',
      score: Math.min(aiScore, quality.score),
      checks: [...aiChecks, ...qualityChecks],
      blockingIssues,
      requiredChanges,
    };
    return { draft, audit };
  });

  return {
    accepted: candidateAudits.filter((item) => item.audit.verdict === 'APPROVED').map((item) => item.draft),
    rejected: candidateAudits.filter((item) => item.audit.verdict !== 'APPROVED').map((item) => item.draft),
    candidateAudits: candidateAudits.map((item) => item.audit),
  };
}

function globalIssuesForItem(
  report: AiAuditReport,
  index: number,
  hasItemAudits: boolean,
): readonly string[] {
  if (report.verdict === 'APPROVED') return [];
  if (!hasItemAudits) {
    return [...report.blockingIssues, ...report.requiredChanges, 'El lote no fue aprobado por el auditor IA.'];
  }

  const affectedIndexes = report.recommendationIndexes ?? [];
  if (affectedIndexes.length > 0 && !affectedIndexes.includes(index)) return [];
  return [...report.blockingIssues, ...report.requiredChanges, 'El auditor IA no aprobó este elemento del lote.'];
}
