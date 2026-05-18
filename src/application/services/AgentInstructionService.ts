import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';
import type {
  AgentInstructionProfile,
  AgentInstructionRules,
  AgentInstructionValidationReport,
  TenantAgentRule,
} from '../../domain/models/AgentContext.js';
import { agentAdminRoles } from '../../domain/models/AgentContext.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';

const forbiddenInstructionPatterns = [
  /ignora(r)?\s+(el\s+)?(sistema|auditor|perfil|instrucciones)/i,
  /sin\s+auditor(i|í)a/i,
  /ejecut(a|ar)\s+automaticamente/i,
  /remediaci(o|ó)n\s+autom(a|á)tica/i,
  /credencial|password|secreto|api\s*key|token/i,
];

export class AgentInstructionService {
  constructor(private readonly repository: IAgentContextRepository) {}

  public async getActiveProfile(): Promise<AgentInstructionProfile> {
    return (await this.repository.findActiveProfile()) ?? this.defaultProfile();
  }

  public async validateAndActivateProfile(input: {
    readonly actor: AuthContext;
    readonly structuredRules: AgentInstructionRules;
    readonly freeformNotes?: string;
  }): Promise<AgentInstructionProfile> {
    this.assertCanAdminAgent(input.actor);
    const validationReport = this.validateProfile(input.structuredRules, input.freeformNotes);

    if (!validationReport.passed) {
      await this.repository.createInstructionAuditEvent({
        actorUserId: input.actor.userId,
        action: 'PROFILE_REJECTED',
        entityType: 'agent_instruction_profile',
        metadata: validationReport,
      });
      throw new FinOpsBaseError(validationReport.issues.join(' '), 'VALIDATION_ERROR');
    }

    const profile = await this.repository.activateProfile({
      actorUserId: input.actor.userId,
      structuredRules: input.structuredRules,
      ...(input.freeformNotes !== undefined ? { freeformNotes: input.freeformNotes } : {}),
      validationReport,
    });

    await this.repository.createInstructionAuditEvent({
      actorUserId: input.actor.userId,
      action: 'PROFILE_ACTIVATED',
      entityType: 'agent_instruction_profile',
      entityId: profile.id,
      metadata: { version: profile.version },
    });

    return profile;
  }

  public async listTenantRules(tenantId: string): Promise<TenantAgentRule[]> {
    return this.repository.listTenantRules(tenantId);
  }

  public async createTenantRule(input: {
    readonly actor: AuthContext;
    readonly category: string;
    readonly ruleText: string;
    readonly priority?: number;
  }): Promise<TenantAgentRule> {
    this.assertCanAdminAgent(input.actor);
    const trimmedRule = input.ruleText.trim();
    const category = input.category.trim();

    if (category === '' || trimmedRule === '') {
      throw new FinOpsBaseError('La categoria y la regla son obligatorias.', 'VALIDATION_ERROR');
    }

    const validation = this.validateFreeText(trimmedRule);

    if (validation.issues.length > 0) {
      throw new FinOpsBaseError(validation.issues.join(' '), 'VALIDATION_ERROR');
    }

    const rule = await this.repository.createTenantRule({
      tenantId: input.actor.tenantId,
      category,
      ruleText: trimmedRule,
      priority: input.priority ?? 100,
      createdByUserId: input.actor.userId,
    });

    await this.repository.createInstructionAuditEvent({
      tenantId: input.actor.tenantId,
      actorUserId: input.actor.userId,
      action: 'TENANT_RULE_CREATED',
      entityType: 'tenant_agent_rule',
      entityId: rule.id,
    });

    return rule;
  }

  public async disableTenantRule(actor: AuthContext, ruleId: string): Promise<TenantAgentRule> {
    this.assertCanAdminAgent(actor);
    const rule = await this.repository.disableTenantRule(actor.tenantId, ruleId);

    if (rule === null) {
      throw new FinOpsBaseError('Tenant rule not found', 'NOT_FOUND');
    }

    await this.repository.createInstructionAuditEvent({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'TENANT_RULE_DISABLED',
      entityType: 'tenant_agent_rule',
      entityId: rule.id,
    });

    return rule;
  }

  public filterRulesAgainstProfile(input: {
    readonly tenantId: string;
    readonly profile: AgentInstructionProfile;
    readonly rules: readonly TenantAgentRule[];
  }): {
    readonly acceptedRules: readonly TenantAgentRule[];
    readonly conflicts: readonly string[];
  } {
    const conflicts: string[] = [];
    const acceptedRules: TenantAgentRule[] = [];

    for (const rule of input.rules) {
      const validation = this.validateFreeText(rule.ruleText);
      const contradictsProfile = this.contradictsGlobalTak(rule.ruleText, input.profile);

      if (validation.issues.length > 0 || contradictsProfile) {
        conflicts.push(`Regla ${rule.id} ignorada: contradice el perfil global TAK o las restricciones de auditoria.`);
      } else {
        acceptedRules.push(rule);
      }
    }

    return { acceptedRules, conflicts };
  }

  private assertCanAdminAgent(actor: AuthContext): void {
    if (!agentAdminRoles.includes(actor.role)) {
      throw new AuthorizationError();
    }
  }

  private validateProfile(
    rules: AgentInstructionRules,
    freeformNotes: string | undefined,
  ): AgentInstructionValidationReport {
    const issues: string[] = [];
    const warnings: string[] = [];

    if (rules.objective.trim().length < 20) {
      issues.push('El objetivo del agente debe tener al menos 20 caracteres.');
    }

    if (rules.tone.trim() === '') {
      issues.push('El tono del agente es obligatorio.');
    }

    if (rules.recommendationPriorities.length === 0) {
      issues.push('Debe existir al menos una prioridad de recomendacion.');
    }

    if (rules.evidenceRequirements.length === 0) {
      issues.push('Debe existir al menos un requisito de evidencia.');
    }

    if (rules.riskPolicy.trim() === '') {
      issues.push('La politica de riesgo es obligatoria.');
    }

    const allText = [
      rules.objective,
      rules.tone,
      ...rules.recommendationPriorities,
      ...rules.evidenceRequirements,
      rules.riskPolicy,
      ...rules.forbiddenActions,
      freeformNotes ?? '',
    ].join('\n');
    const textValidation = this.validateFreeText(allText);

    issues.push(...textValidation.issues);
    warnings.push(...textValidation.warnings);

    if (allText.length > 8000) {
      issues.push('El perfil TAK no puede superar 8000 caracteres.');
    }

    return {
      passed: issues.length === 0,
      issues,
      warnings,
    };
  }

  private validateFreeText(text: string): { readonly issues: string[]; readonly warnings: string[] } {
    const issues = forbiddenInstructionPatterns
      .filter((pattern) => pattern.test(text))
      .map(() => 'La instruccion contiene contenido inseguro: no puede omitir auditoria, guardar secretos ni ejecutar remediacion automatica.');

    return {
      issues: [...new Set(issues)],
      warnings: text.length > 4000 ? ['La instruccion es extensa y puede aumentar consumo de tokens.'] : [],
    };
  }

  private contradictsGlobalTak(ruleText: string, profile: AgentInstructionProfile): boolean {
    const normalized = ruleText.toLowerCase();

    if (normalized.includes('no usar evidencia') || normalized.includes('sin evidencia')) {
      return true;
    }

    if (
      profile.structuredRules.forbiddenActions.some((action) => (
        action.trim() !== '' && normalized.includes(action.toLowerCase())
      ))
    ) {
      return true;
    }

    return false;
  }

  private defaultProfile(): AgentInstructionProfile {
    const now = new Date(0);

    return {
      id: 'default-tak-profile',
      version: 0,
      status: 'ACTIVE',
      structuredRules: {
        objective: 'Generar recomendaciones FinOps en espanol, accionables, auditables y basadas en evidencia real.',
        tone: 'Profesional, claro, prudente y orientado a operaciones.',
        recommendationPriorities: [
          'Priorizar ahorro verificable y bajo riesgo operativo.',
          'Explicar limites de evidencia cuando solo existan datos FOCUS.',
          'No recomendar cambios tecnicos fuertes sin metricas tecnicas suficientes.',
        ],
        evidenceRequirements: [
          'Usar costos, consumo facturado, cuenta, servicio y recurso cuando esten disponibles.',
          'Declarar si la recomendacion requiere validacion tecnica adicional.',
        ],
        riskPolicy: 'No prometer remediacion automatica; toda ejecucion debe ser manual, gobernada y reversible.',
        forbiddenActions: [
          'ejecutar automaticamente cambios cloud',
          'ignorar auditoria',
          'inventar recursos',
          'inferir CPU, memoria, IOPS o throughput desde FOCUS',
        ],
      },
      createdByUserId: 'system',
      createdAt: now,
      updatedAt: now,
    };
  }
}
