import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';

/** Minimum score required before an AI-generated FinOps artifact can be used. */
export const MIN_APPROVED_AUDIT_SCORE = 80;

/**
 * Applies the non-negotiable approval policy at the persistence boundary.
 * A model verdict is advisory: all checks, blockers and the minimum score must
 * agree before an artifact is considered approved.
 */
export function isAuditApproved(report: AiAuditReport): boolean {
  return report.verdict === 'APPROVED'
    && report.score >= MIN_APPROVED_AUDIT_SCORE
    && report.blockingIssues.length === 0
    && report.requiredChanges.length === 0
    && report.checks.every((check) => check.passed);
}
