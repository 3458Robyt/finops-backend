import { describe, expect, it } from 'vitest';
import { CostAllocationService } from './CostAllocationService.js';
import type { ICostAllocationRepository } from '../../domain/interfaces/ICostAllocationRepository.js';
import type { CostAllocationRule } from '../../domain/models/CostAllocation.js';

const actor = { userId: 'user-1', tenantId: 'tenant-1', email: 'admin@example.com', role: 'ADMIN', jwtId: 'jwt-1' } as const;
const ruleInput = { name: 'Compute producción', priority: 10, status: 'DRAFT' as const, serviceName: 'Compute', costCenter: 'CC-100' };

describe('CostAllocationService', () => {
  it('creates an auditable rule and validates criteria and target', async () => {
    const repository = new FakeRepository();
    const service = new CostAllocationService(repository as unknown as ICostAllocationRepository);
    await expect(service.createRule(actor, ruleInput)).resolves.toMatchObject({ name: 'Compute producción' });
    expect(repository.auditActions).toEqual(['COST_ALLOCATION_RULE_CREATED']);
    await expect(service.createRule(actor, { ...ruleInput, serviceName: undefined })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('allows viewers to query but not change rules', async () => {
    const service = new CostAllocationService(new FakeRepository() as unknown as ICostAllocationRepository);
    const viewer = { ...actor, role: 'CLIENT_VIEWER' as const };
    await expect(service.summary(viewer, { period: '2026-05' })).resolves.toEqual([]);
    await expect(service.createRule(viewer, ruleInput)).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
  });
});

class FakeRepository {
  public readonly auditActions: string[] = [];
  private readonly rules: CostAllocationRule[] = [];
  public async listRules(): Promise<readonly CostAllocationRule[]> { return this.rules; }
  public async findRule(_tenantId: string, id: string): Promise<CostAllocationRule | null> { return this.rules.find((rule) => rule.id === id) ?? null; }
  public async createRule(tenantId: string, userId: string, input: typeof ruleInput): Promise<CostAllocationRule> { const now = new Date(); const rule: CostAllocationRule = { id: `rule-${this.rules.length + 1}`, tenantId, createdByUserId: userId, createdAt: now, updatedAt: now, ...input }; this.rules.push(rule); return rule; }
  public async updateRule(): Promise<CostAllocationRule | null> { return this.rules[0] ?? null; }
  public async archiveRule(): Promise<CostAllocationRule | null> { return this.rules[0] ?? null; }
  public async summarize() { return []; }
  public async preview() { return []; }
  public async unallocated() { return []; }
  public async writeAudit(_tenantId: string, _userId: string, action: string): Promise<void> { this.auditActions.push(action); }
}
