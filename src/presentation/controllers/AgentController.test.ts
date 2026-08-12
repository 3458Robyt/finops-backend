import { describe, expect, test, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';
import type { AgentQualityReport } from '../../domain/models/AgentQuality.js';
import type { AgentQualityService } from '../../application/services/AgentQualityService.js';
import type { ContextSummaryBuilderService } from '../../application/services/ContextSummaryBuilderService.js';
import type { AgentInstructionService } from '../../application/services/AgentInstructionService.js';
import { AgentController } from './AgentController.js';

function buildReport(): AgentQualityReport {
  return {
    generatedAt: new Date('2026-08-12T12:00:00.000Z'),
    periodStart: new Date('2026-05-14T12:00:00.000Z'),
    periodEnd: new Date('2026-08-12T12:00:00.000Z'),
    totals: {
      generated: 0, reviewed: 0, approved: 0, rejected: 0, markedDone: 0,
      reviewRate: null, approvalRate: null, rejectionRate: null,
      abstained: 0, insufficientEvidence: 0, verified: 0,
      estimatedSavings: 0, verifiedSavings: 0,
      estimatedVsVerifiedErrorPercent: null, verifiedOutcomeRate: null,
    },
    dimensions: [],
    traces: {
      calls: 0, successfulCalls: 0, failedCalls: 0, successRate: null,
      averageLatencyMs: null, p95LatencyMs: null, promptTokens: 0,
      responseTokens: 0, totalTokens: 0, estimatedCostUsd: null,
      costEstimateAvailable: false,
    },
    notes: [],
  };
}

function buildResponse(): Response & { statusCode?: number; body?: unknown } {
  return {
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  } as Response & { statusCode?: number; body?: unknown };
}

function buildRequest(role: 'FINOPS_TECHNICIAN' | 'VIEWER', days: string): Request {
  return {
    auth: {
      userId: 'user-1', tenantId: 'tenant-a', email: 'tech@example.com',
      role, jwtId: 'jwt-1',
    },
    query: { days },
  } as unknown as Request;
}

describe('AgentController quality report', () => {
  test('scopes the report to the authenticated tenant and clamps the period', async () => {
    const getReport = vi.fn().mockResolvedValue(buildReport());
    const controller = new AgentController(
      {} as AgentInstructionService,
      {} as IAgentContextRepository,
      {} as ContextSummaryBuilderService,
      { getReport } as unknown as AgentQualityService,
    );
    const response = buildResponse();

    await controller.getQualityReport(buildRequest('FINOPS_TECHNICIAN', '9999'), response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ success: true, report: { totals: { generated: 0 } } });
    expect(getReport).toHaveBeenCalledWith('tenant-a', 365);
  });

  test('does not expose calibration metrics to a viewer', async () => {
    const getReport = vi.fn();
    const controller = new AgentController(
      {} as AgentInstructionService,
      {} as IAgentContextRepository,
      {} as ContextSummaryBuilderService,
      { getReport } as unknown as AgentQualityService,
    );
    const response = buildResponse();

    await controller.getQualityReport(buildRequest('VIEWER', '90'), response);

    expect(response.statusCode).toBe(403);
    expect(getReport).not.toHaveBeenCalled();
  });
});
