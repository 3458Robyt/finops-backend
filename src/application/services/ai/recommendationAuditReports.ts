import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
import type { QualityReport } from './evaluation/qualityRubric.js';

export function readRepairInstructions(audit: AiAuditReport): readonly string[] {
  return (audit.repairInstructions?.length ?? 0) > 0 ? audit.repairInstructions! : audit.requiredChanges;
}

export function buildDeterministicRejectionReport(quality: QualityReport): AiAuditReport {
  const failedChecks = quality.checks.filter((check) => !check.passed);
  const issues = failedChecks.map((check) => check.detail);
  return {
    verdict: 'REJECTED',
    score: quality.score,
    checks: quality.checks.map((check) => ({
      name: `deterministic:${check.name}`,
      passed: check.passed,
      notes: check.detail,
    })),
    blockingIssues: issues,
    requiredChanges: issues,
  };
}
