import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';
import type {
  AgentInstructionProfile,
  AgentInstructionRules,
  TenantAgentRule,
} from '../../domain/models/AgentContext.js';
import { agentAdminRoles } from '../../domain/models/AgentContext.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import {
  defaultProfile,
  filterRulesAgainstProfile,
  validateFreeText,
  validateProfile,
} from './agentInstruction/agentInstructionValidation.js';

/**
 * Servicio de aplicación de instrucciones del agente IA (perfil TAK).
 *
 * Responsabilidad: gobernar el "perfil de instrucciones" global del agente
 * y las reglas específicas por tenant que personalizan su comportamiento.
 * Aplica validaciones de seguridad y de negocio antes de activar cualquier
 * instrucción, y deja traza de auditoría de cada cambio relevante. La lógica
 * pura de validación y el perfil por defecto residen en
 * {@link ./agentInstruction/agentInstructionValidation}.
 *
 * Colaborador inyectado (DIP):
 * - {@link IAgentContextRepository}: persistencia del perfil activo, las
 *   reglas por tenant y los eventos de auditoría de instrucciones.
 */
export class AgentInstructionService {
  /**
   * @param repository - Repositorio del contexto del agente (perfil, reglas
   *                      por tenant y auditoría de instrucciones).
   */
  constructor(private readonly repository: IAgentContextRepository) {}

  /**
   * Obtiene el perfil de instrucciones activo del agente.
   *
   * @returns El perfil activo persistido o, si no existe, un perfil por
   *          defecto seguro ({@link defaultProfile}) como respaldo.
   */
  public async getActiveProfile(): Promise<AgentInstructionProfile> {
    return (await this.repository.findActiveProfile()) ?? defaultProfile();
  }

  /**
   * Valida y activa un nuevo perfil de instrucciones (operación de administración).
   *
   * Efectos secundarios: registra un evento de auditoría tanto si el perfil
   * es rechazado (`PROFILE_REJECTED`) como si se activa (`PROFILE_ACTIVATED`),
   * y **persiste** el nuevo perfil cuando supera la validación.
   *
   * @param input - Actor que ejecuta la acción, reglas estructuradas del
   *                perfil y notas en texto libre opcionales.
   * @returns El perfil activado.
   *
   * @throws {AuthorizationError} Si el actor no tiene rol de administrador del agente.
   * @throws {FinOpsBaseError} Con código `VALIDATION_ERROR` si el perfil no pasa la validación.
   */
  public async validateAndActivateProfile(input: {
    readonly actor: AuthContext;
    readonly structuredRules: AgentInstructionRules;
    readonly freeformNotes?: string;
  }): Promise<AgentInstructionProfile> {
    this.assertCanAdminAgent(input.actor);
    const validationReport = validateProfile(input.structuredRules, input.freeformNotes);

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

  /**
   * Lista las reglas del agente definidas por un tenant.
   *
   * @param tenantId - Identificador del tenant.
   * @returns Reglas del agente asociadas al tenant.
   */
  public async listTenantRules(tenantId: string): Promise<TenantAgentRule[]> {
    return this.repository.listTenantRules(tenantId);
  }

  /**
   * Crea una regla del agente específica de un tenant (operación de administración).
   *
   * Efectos secundarios: **persiste** la regla y registra un evento de
   * auditoría `TENANT_RULE_CREATED`.
   *
   * @param input - Actor, categoría, texto de la regla y prioridad opcional
   *                (por defecto 100; menor valor implica mayor prioridad según convención del dominio).
   * @returns La regla creada.
   *
   * @throws {AuthorizationError} Si el actor no es administrador del agente.
   * @throws {FinOpsBaseError} Con código `VALIDATION_ERROR` si la categoría o la regla
   *         están vacías, o si el texto contiene contenido inseguro.
   */
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

    const validation = validateFreeText(trimmedRule);

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

  /**
   * Desactiva una regla del agente de un tenant (operación de administración).
   *
   * Efectos secundarios: **persiste** la desactivación y registra un evento
   * de auditoría `TENANT_RULE_DISABLED`.
   *
   * @param actor  - Actor que ejecuta la acción.
   * @param ruleId - Identificador de la regla a desactivar.
   * @returns La regla desactivada.
   *
   * @throws {AuthorizationError} Si el actor no es administrador del agente.
   * @throws {FinOpsBaseError} Con código `NOT_FOUND` si la regla no existe para el tenant.
   */
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

  /**
   * Filtra reglas de tenant frente al perfil global, descartando las que
   * son inseguras o que contradicen el perfil TAK activo. Delega en la función
   * pura {@link filterRulesAgainstProfile} de la capa de validación.
   *
   * @param input - Tenant, perfil global activo y reglas candidatas.
   * @returns Reglas aceptadas y la lista de conflictos descriptivos de las
   *          reglas descartadas.
   */
  public filterRulesAgainstProfile(input: {
    readonly tenantId: string;
    readonly profile: AgentInstructionProfile;
    readonly rules: readonly TenantAgentRule[];
  }): {
    readonly acceptedRules: readonly TenantAgentRule[];
    readonly conflicts: readonly string[];
  } {
    return filterRulesAgainstProfile(input);
  }

  /**
   * Verifica que el actor tenga rol de administrador del agente.
   *
   * @throws {AuthorizationError} Si el rol del actor no está en {@link agentAdminRoles}.
   */
  private assertCanAdminAgent(actor: AuthContext): void {
    if (!agentAdminRoles.includes(actor.role)) {
      throw new AuthorizationError();
    }
  }
}
