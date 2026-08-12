/** Shared deterministic AI quality report types. */
export interface QualityCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface QualityReport {
  readonly passed: boolean;
  readonly score: number;
  readonly checks: readonly QualityCheck[];
}

export function toReport(checks: readonly QualityCheck[]): QualityReport {
  const passedCount = checks.filter((check) => check.passed).length;
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100);

  return {
    passed: passedCount === checks.length,
    score,
    checks,
  };
}
