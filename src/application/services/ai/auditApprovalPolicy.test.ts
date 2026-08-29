import { describe, expect, test } from 'vitest';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
import { isAuditApproved } from './auditApprovalPolicy.js';

const report = (overrides: Partial<AiAuditReport> = {}): AiAuditReport => ({
  verdict: 'APPROVED',
  score: 90,
  checks: [{ name: 'evidence', passed: true, notes: 'ok' }],
  blockingIssues: [],
  requiredChanges: [],
  ...overrides,
});

describe('auditApprovalPolicy', () => {
  test.each([
    ['requires the minimum score', { score: 79 }, false],
    ['rejects blockers even when the model says approved', { blockingIssues: ['resource not found'] }, false],
    ['rejects required changes', { requiredChanges: ['add rollback'] }, false],
    ['rejects failed checks', { checks: [{ name: 'evidence', passed: false, notes: 'missing' }] }, false],
    ['accepts a complete approved report', {}, true],
  ])('%s', (_name, overrides, expected) => {
    expect(isAuditApproved(report(overrides))).toBe(expected);
  });

  test('does not treat a revision request as approved', () => {
    expect(isAuditApproved(report({ verdict: 'NEEDS_REVISION' }))).toBe(false);
  });
});
