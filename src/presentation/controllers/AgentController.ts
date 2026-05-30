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

/**
 * Controlador de la capa de presentación para el recurso "agente" (montado en
 * `/api/v1/agent`). Traduce las peticiones HTTP hacia los casos de uso de la
 * capa de aplicación y devuelve la respuesta serializada al cliente.
 *
 * Gestiona el perfil de instrucciones del agente IA, las reglas específicas del
 * tenant, las trazas de contexto IA, el grafo de conocimiento contextual y el
 * proceso de backfill de contexto.
 *
 * Servicios y dependencias que utiliza:
 * - {@link AgentInstructionService}: gestión del perfil activo y de las reglas tenant.
 * - {@link IAgentContextRepository}: lectura de trazas de contexto IA.
 * - {@link ContextSummaryBuilderService}: backfill de resúmenes de contexto del tenant.
 * - {@link KnowledgeGraphService}: grafo contextual y backfill del grafo.
 *
 * Todas las rutas requieren autenticación; varias operaciones exigen además rol
 * de administrador de agente o rol técnico de agente.
 */
export class AgentController {
  constructor(
    private readonly instructionService: AgentInstructionService,
    private readonly contextRepository: IAgentContextRepository,
    private readonly summaryBuilder: ContextSummaryBuilderService,
    private readonly knowledgeGraphService: KnowledgeGraphService,
  ) {}

  /**
   * Devuelve el perfil de instrucciones del agente actualmente activo.
   *
   * Sirve: GET /api/v1/agent/profile
   * Autenticación: requerida (cualquier usuario autenticado).
   *
   * Respuestas:
   * - 200: `{ success: true, profile }` con el perfil activo.
   * - 401 AUTHENTICATION_REQUIRED: no hay sesión autenticada (`req.auth` ausente).
   * - 500: error inesperado al cargar el perfil.
   */
  public getProfile = async (req: Request, res: Response): Promise<void> => {
    try {
      this.requireAuthenticated(req);
      const profile = await this.instructionService.getActiveProfile();
      res.status(200).json({ success: true, profile });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible cargar el perfil del agente');
    }
  };

  /**
   * Valida y activa un nuevo perfil de instrucciones del agente.
   *
   * Sirve: POST /api/v1/agent/profile/activate
   * Autenticación: requerida. Rol: administrador de agente ({@link agentAdminRoles}).
   *
   * Cuerpo (`req.body`, validado con `profileSchema`):
   * - `structuredRules`: reglas estructuradas del agente (objetivo, tono,
   *   prioridades de recomendación, requisitos de evidencia, política de riesgo,
   *   acciones prohibidas).
   * - `freeformNotes` (opcional): notas en texto libre.
   *
   * Respuestas:
   * - 200: `{ success: true, profile }` con el perfil activado.
   * - 400 VALIDATION_ERROR: el cuerpo no cumple el esquema.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403: el rol del usuario no es administrador de agente.
   * - 404 / 400: otros errores de dominio según el código.
   * - 500: error inesperado al activar el perfil.
   */
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

  /**
   * Lista las reglas específicas del tenant del usuario autenticado.
   *
   * Sirve: GET /api/v1/agent/tenant-rules
   * Autenticación: requerida. Rol: administrador de agente ({@link agentAdminRoles}).
   * Usa `req.auth.tenantId` para acotar las reglas al tenant.
   *
   * Respuestas:
   * - 200: `{ success: true, rules }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403: el rol del usuario no es administrador de agente.
   * - 500: error inesperado al cargar las reglas.
   */
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

  /**
   * Crea una nueva regla específica del tenant.
   *
   * Sirve: POST /api/v1/agent/tenant-rules
   * Autenticación: requerida. Rol: administrador de agente ({@link agentAdminRoles}).
   *
   * Cuerpo (`req.body`, validado con `tenantRuleSchema`):
   * - `category`: categoría de la regla.
   * - `ruleText`: texto de la regla.
   * - `priority` (opcional): prioridad entera entre 1 y 1000.
   *
   * Respuestas:
   * - 201: `{ success: true, rule }` con la regla creada.
   * - 400 VALIDATION_ERROR: el cuerpo no cumple el esquema.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403: el rol del usuario no es administrador de agente.
   * - 500: error inesperado al crear la regla.
   */
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

  /**
   * Desactiva una regla del tenant identificada por su id.
   *
   * Sirve: PATCH /api/v1/agent/tenant-rules/:id/disable
   * Autenticación: requerida. Rol: administrador de agente ({@link agentAdminRoles}).
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la regla a desactivar.
   *
   * Respuestas:
   * - 200: `{ success: true, rule }` con la regla desactivada.
   * - 400 VALIDATION_ERROR: falta el `id` de la regla.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403: el rol del usuario no es administrador de agente.
   * - 404 NOT_FOUND: la regla no existe.
   * - 500: error inesperado al desactivar la regla.
   */
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

  /**
   * Lista las trazas de contexto IA del tenant.
   *
   * Sirve: GET /api/v1/agent/context-traces
   * Autenticación: requerida. Rol: técnico de agente ({@link agentTechnicalRoles}).
   *
   * Parámetros de consulta:
   * - `limit` (`req.query.limit`, opcional): número máximo de trazas; por
   *   defecto 30 y acotado a un máximo de 100.
   *
   * Respuestas:
   * - 200: `{ success: true, traces }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403: el rol del usuario no es técnico de agente.
   * - 500: error inesperado al cargar las trazas.
   */
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

  /**
   * Devuelve el grafo de conocimiento contextual del tenant, opcionalmente
   * centrado en una recomendación o un recurso concretos (profundidad fija 2).
   *
   * Sirve: GET /api/v1/agent/knowledge-graph
   * Autenticación: requerida. Rol: técnico de agente ({@link agentTechnicalRoles}).
   *
   * Parámetros de consulta (opcionales):
   * - `recommendationId` (`req.query.recommendationId`): centra el grafo en una recomendación.
   * - `resourceId` (`req.query.resourceId`): centra el grafo en un recurso.
   *
   * Respuestas:
   * - 200: `{ success: true, graph }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403: el rol del usuario no es técnico de agente.
   * - 500: error inesperado al cargar el grafo.
   */
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

  /**
   * Ejecuta el backfill de contexto del tenant: reconstruye en paralelo los
   * resúmenes de contexto y el grafo de conocimiento.
   *
   * Sirve: POST /api/v1/agent/context/backfill
   * Autenticación: requerida. Rol: administrador de agente ({@link agentAdminRoles}).
   * Usa `req.auth.tenantId` y `req.auth.userId` para acotar y registrar el proceso.
   *
   * Respuestas:
   * - 200: `{ success: true, summaries, graph }` con los resultados del backfill.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403: el rol del usuario no es administrador de agente.
   * - 500: error inesperado durante el backfill.
   */
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

  /**
   * Garantiza que la petición está autenticada. Devuelve el contexto de
   * autenticación (`req.auth`) o lanza un error AUTHENTICATION_REQUIRED
   * (mapeado a 401) si no existe sesión.
   */
  private requireAuthenticated(req: Request): NonNullable<Request['auth']> {
    if (req.auth === undefined) {
      throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED');
    }

    return req.auth;
  }

  /**
   * Verifica que el rol pertenezca a los roles de administrador de agente.
   * Lanza {@link AuthorizationError} (mapeado a 403) en caso contrario.
   */
  private requireAgentAdmin(role: UserRole): void {
    if (!agentAdminRoles.includes(role)) {
      throw new AuthorizationError();
    }
  }

  /**
   * Verifica que el rol pertenezca a los roles técnicos de agente.
   * Lanza {@link AuthorizationError} (mapeado a 403) en caso contrario.
   */
  private requireAgentTechnical(role: UserRole): void {
    if (!agentTechnicalRoles.includes(role)) {
      throw new AuthorizationError();
    }
  }

  /**
   * Normaliza un valor de entrada a string: devuelve la cadena recortada si es
   * un texto no vacío, o `undefined` en cualquier otro caso. Útil para depurar
   * parámetros de ruta y de consulta opcionales.
   */
  private parseString(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.trim() === '') {
      return undefined;
    }

    return value.trim();
  }

  /**
   * Manejador centralizado de errores que traduce excepciones de dominio a
   * códigos de estado HTTP:
   * - {@link AuthorizationError} -> 403.
   * - {@link FinOpsBaseError} con código `NOT_FOUND` -> 404;
   *   `AUTHENTICATION_REQUIRED` -> 401; cualquier otro código -> 400.
   * - Error no controlado -> 500 con `fallbackMessage`.
   */
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
