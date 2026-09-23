import { describe, expect, it } from 'vitest';
import { portfolioCte } from './valueRealizationRepositorySql.js';

describe('value realization savings SQL', () => {
  it('includes estimates only when server price evidence matches the stored amount', () => {
    const sql = portfolioCte('tenant-1').sql;
    expect(sql).toContain("'SERVER_DETERMINISTIC'");
    expect(sql).toContain("'priced-alternative/v1'");
    expect(sql).toContain("'BASELINE_MINUS_ALTERNATIVE_MONTHLY'");
    expect(sql).toContain('priceEvidenceRef');
    expect(sql.match(/AS estimated_monthly_savings/g)).toHaveLength(1);
    expect(sql).toContain('ELSE 0');
  });
});
