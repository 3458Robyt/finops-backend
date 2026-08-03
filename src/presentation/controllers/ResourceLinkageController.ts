import type { Request, Response } from 'express';
import type { ResourceLinkageReadinessService } from '../../application/services/ResourceLinkageReadinessService.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import { resolveFinOpsError } from '../http/finOpsErrorResponse.js';

export class ResourceLinkageController {
  public constructor(private readonly service: ResourceLinkageReadinessService) {}

  public getReadiness = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const rawLimit = typeof req.query['limit'] === 'string' ? Number.parseInt(req.query['limit'], 10) : undefined;
      const readiness = await this.service.getForTenant(tenantId, rawLimit);
      res.status(200).json({ success: true, readiness });
    } catch (error: unknown) {
      const resolved = resolveFinOpsError(error, 'No se pudo cargar la cobertura de trazabilidad por recurso.');
      res.status(resolved.status).json({ success: false, error: resolved.error, ...(resolved.code !== undefined ? { code: resolved.code } : {}) });
    }
  };

  private requireTenant(req: Request): string {
    const tenantId = req.auth?.tenantId;
    if (tenantId === undefined || tenantId.trim() === '') {
      throw new FinOpsBaseError('La sesión no tiene un tenant activo.', 'AUTHENTICATION_REQUIRED');
    }
    return tenantId;
  }
}
