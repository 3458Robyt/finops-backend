import { describe, expect, test, vi } from 'vitest';
import type { Request, Response } from 'express';

import { AiController } from './AiController.js';
import type { FinOpsAiService } from '../../application/services/FinOpsAiService.js';
import type { IAgentLearningService } from '../../domain/interfaces/IAgentLearningService.js';

describe('AiController learning summary authorization', () => {
  test('denies client access to agent learning governance data', async () => {
    const getLearningSummary = vi.fn(async () => ({}));
    const controller = new AiController(
      {} as FinOpsAiService,
      { getLearningSummary } as unknown as IAgentLearningService,
    );
    const req = {
      auth: { userId: 'client-1', tenantId: 'tenant-1', email: 'client@example.test', role: 'CLIENT_VIEWER', jwtId: 'jwt-1' },
      path: '/learning/summary',
    } as Request;
    const json = vi.fn();
    const res = {
      status: vi.fn().mockReturnThis(),
      json,
    } as unknown as Response;

    await controller.getLearningSummary(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getLearningSummary).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  test('allows a FinOps technician to read agent learning summary', async () => {
    const summary = { activeMemories: 2 };
    const getLearningSummary = vi.fn(async () => summary);
    const controller = new AiController(
      {} as FinOpsAiService,
      { getLearningSummary } as unknown as IAgentLearningService,
    );
    const req = {
      auth: { userId: 'tech-1', tenantId: 'tenant-1', email: 'tech@example.test', role: 'FINOPS_TECHNICIAN', jwtId: 'jwt-2' },
      path: '/learning/summary',
    } as Request;
    const json = vi.fn();
    const res = {
      status: vi.fn().mockReturnThis(),
      json,
    } as unknown as Response;

    await controller.getLearningSummary(req, res);

    expect(getLearningSummary).toHaveBeenCalledWith('tenant-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, learning: summary });
  });
});

describe('AiController chat tenant scope', () => {
  test('uses the authenticated tenant instead of a client-supplied tenant id', async () => {
    const answerChat = vi.fn().mockResolvedValue({
      answer: 'No hay suficiente evidencia para responder.',
      snapshot: {
        periodStart: '2026-01-01',
        periodEnd: '2026-02-01',
        totalCost: 0,
        currency: 'COP',
        metricCount: 0,
      },
    });
    const controller = new AiController({ answerChat } as unknown as FinOpsAiService);
    const req = {
      auth: { userId: 'viewer-1', tenantId: 'tenant-authorized', email: 'viewer@example.test', role: 'CLIENT_VIEWER', jwtId: 'jwt-3' },
      body: { message: '¿Cuál es el mayor costo?', tenantId: 'tenant-attacker', traceSource: 'EVALUATION' },
      path: '/chat',
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await controller.chat(req, res);

    expect(answerChat).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-authorized', traceSource: 'WEB' }));
    expect(answerChat).not.toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-attacker' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('does not invoke AI chat without an authenticated tenant', async () => {
    const answerChat = vi.fn();
    const controller = new AiController({ answerChat } as unknown as FinOpsAiService);
    const req = {
      body: { message: '¿Cuál es el mayor costo?', tenantId: 'tenant-attacker' },
      path: '/chat',
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await controller.chat(req, res);

    expect(answerChat).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
