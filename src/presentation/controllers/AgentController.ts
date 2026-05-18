import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AgentInstructionService } from '../../application/services/AgentInstructionService.js';
import type { ContextSummaryBuilderService } from '../../application/services/ContextSummaryBuilderService.js';
import type { KnowledgeGraphService } from '../../application/services/KnowledgeGraphService.js';
import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';
import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import { agentAdminRoles, agentTechnicalRoles } from '../../domain/models/AgentContext.js';
import type { UserRole } from '../../domain/models/AuthContext.js';

const profileSchema = z.object({
  structuredRules: z.object({
    objective: z.string().min(20),
    tone: z.string().min(1),
    recommendationPriorities: z.array(z.string().min(1)).min(1),
    evidenceRequirements: z.array(z.string().min(1)).min(1),
    riskPolicy: z.string().min(1),
    forbiddenActions: z.array(z.string().min(1)).default([]),
  }),
  freeformNotes: z.string().optional(),
});

const tenantRuleSchema = z.object({
  category: z.string().min(1),
  ruleText: z.string().min(1),
  priority: z.number().int().min(1).max(1000).optional(),
});

export class AgentController {
  constructor(
    private readonly instructionService: AgentInstructionService,
    private readonly contextRepository: IAgentContextRepository,
    private readonly summaryBuilder: ContextSummaryBuilderService,
    private readonly knowledgeGraphService: KnowledgeGraphService,
  ) {}

  public getProfile = async (req: Request, res: Response): Promise<void> => {
    try {
      this.requireAuthenticated(req);
      const profile = await this.instructionService.getActiveProfile();
      res.status(200).json({ success: true, profile });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible cargar el perfil del agente');
    }
  };

  public activateProfile = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      this.requireAgentAdmin(auth.role);
      const parsed = profileSchema.safeParse(req.body);

      if (!parsed.success) {
        throw new FinOpsBaseError('Perfil de agente invalido', 'VALIDATION_ERROR');
      }

      const profile = await this.instructionService.validateAndActivateProfile({
        actor: auth,
        structuredRules: parsed.data.structuredRules,
        ...(parsed.data.freeformNotes !== undefined ? { freeformNotes: parsed.data.freeformNotes } : {}),
      });

      res.status(200).json({ success: true, profile });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible activar el perfil del agente');
    }
  };

  public listTenantRules = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      this.requireAgentAdmin(auth.role);
      const rules = await this.instructionService.listTenantRules(auth.tenantId);
      res.status(200).json({ success: true, rules });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible cargar reglas tenant');
    }
  };

  public createTenantRule = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      this.requireAgentAdmin(auth.role);
      const parsed = tenantRuleSchema.safeParse(req.body);

      if (!parsed.success) {
        throw new FinOpsBaseError('Regla tenant invalida', 'VALIDATION_ERROR');
      }

      const rule = await this.instructionService.createTenantRule({
        actor: auth,
        category: parsed.data.category,
        ruleText: parsed.data.ruleText,
        ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
      });

      res.status(201).json({ success: true, rule });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible crear la regla tenant');
    }
  };

  public disableTenantRule = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      this.requireAgentAdmin(auth.role);
      const ruleId = this.parseString(req.params['id']);

      if (ruleId === undefined) {
        throw new FinOpsBaseError('Rule id is required', 'VALIDATION_ERROR');
      }

      const rule = await this.instructionService.disableTenantRule(auth, ruleId);
      res.status(200).json({ success: true, rule });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible desactivar la regla tenant');
    }
  };

  public listContextTraces = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      this.requireAgentTechnical(auth.role);
      const limit = Math.min(Number.parseInt(String(req.query['limit'] ?? '30'), 10) || 30, 100);
      const traces = await this.contextRepository.listAiContextTraces({
        tenantId: auth.tenantId,
        limit,
      });
      res.status(200).json({ success: true, traces });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible cargar trazas IA');
    }
  };

  public getKnowledgeGraph = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      this.requireAgentTechnical(auth.role);
      const recommendationId = this.parseString(req.query['recommendationId']);
      const resourceId = this.parseString(req.query['resourceId']);

      const graph = await this.knowledgeGraphService.getContextualGraph({
        tenantId: auth.tenantId,
        ...(recommendationId !== undefined ? { recommendationId } : {}),
        ...(resourceId !== undefined ? { resourceId } : {}),
        depth: 2,
      });

      res.status(200).json({ success: true, graph });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible cargar el grafo contextual');
    }
  };

  public backfillContext = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      this.requireAgentAdmin(auth.role);
      const [summaries, graph] = await Promise.all([
        this.summaryBuilder.backfillTenantContext({
          tenantId: auth.tenantId,
          userId: auth.userId,
        }),
        this.knowledgeGraphService.backfillTenantGraph({
          tenantId: auth.tenantId,
          userId: auth.userId,
        }),
      ]);

      res.status(200).json({
        success: true,
        summaries,
        graph,
      });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible ejecutar backfill de contexto');
    }
  };

  private requireAuthenticated(req: Request): NonNullable<Request['auth']> {
    if (req.auth === undefined) {
      throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED');
    }

    return req.auth;
  }

  private requireAgentAdmin(role: UserRole): void {
    if (!agentAdminRoles.includes(role)) {
      throw new AuthorizationError();
    }
  }

  private requireAgentTechnical(role: UserRole): void {
    if (!agentTechnicalRoles.includes(role)) {
      throw new AuthorizationError();
    }
  }

  private parseString(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.trim() === '') {
      return undefined;
    }

    return value.trim();
  }

  private handleError(error: unknown, res: Response, fallbackMessage: string): void {
    if (error instanceof AuthorizationError) {
      res.status(403).json({ success: false, error: error.message, code: error.code });
      return;
    }

    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'AUTHENTICATION_REQUIRED'
          ? 401
          : 400;
      res.status(status).json({ success: false, error: error.message, code: error.code });
      return;
    }

    res.status(500).json({ success: false, error: fallbackMessage });
  }
}
