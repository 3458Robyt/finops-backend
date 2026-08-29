import type { Request, Response } from 'express';
import type { MasterAdminIngestionJobService } from '../../application/services/MasterAdminIngestionJobService.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IngestionJobStatus, IngestionSourceType } from '../../domain/models/CloudConnection.js';
import { respondWithFinOpsError } from '../http/finOpsErrorResponse.js';

export class MasterAdminIngestionController {
  public constructor(private readonly service: MasterAdminIngestionJobService) {}

  public list = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.optionalQuery(req, 'tenantId');
      const status = this.optionalQuery(req, 'status');
      const sourceType = this.optionalQuery(req, 'sourceType');
      const limit = this.parseLimit(this.optionalQuery(req, 'limit'));
      const jobs = await this.service.list({
        actorUserId: this.requireActor(req),
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(status !== undefined ? { status: this.parseStatus(status) } : {}),
        ...(sourceType !== undefined ? { sourceType: this.parseSourceType(sourceType) } : {}),
        includeArchived: this.optionalQuery(req, 'includeArchived') === 'true',
        ...(limit !== undefined ? { limit } : {}),
      });
      res.status(200).json({ success: true, ...jobs });
    } catch (error: unknown) {
      this.respond(res, error);
    }
  };

  public reconcile = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await this.service.reconcileStale(this.requireActor(req));
      res.status(200).json({ success: true, result });
    } catch (error: unknown) {
      this.respond(res, error);
    }
  };

  public deletePending = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await this.service.deletePending(this.requireActor(req));
      res.status(200).json({ success: true, result });
    } catch (error: unknown) {
      this.respond(res, error);
    }
  };

  public cancel = async (req: Request, res: Response): Promise<void> => {
    try {
      const job = await this.service.cancel(this.requireActor(req), this.requireParam(req, 'jobId'));
      res.status(200).json({ success: true, job });
    } catch (error: unknown) {
      this.respond(res, error);
    }
  };

  public archive = async (req: Request, res: Response): Promise<void> => {
    try {
      const job = await this.service.archive(this.requireActor(req), this.requireParam(req, 'jobId'));
      res.status(200).json({ success: true, job });
    } catch (error: unknown) {
      this.respond(res, error);
    }
  };

  private requireActor(req: Request): string {
    if (req.auth === undefined) throw new FinOpsBaseError('Authentication required', 'AUTHENTICATION_REQUIRED');
    return req.auth.userId;
  }

  private requireParam(req: Request, name: string): string {
    const value = req.params[name];
    if (typeof value !== 'string' || value.trim() === '') throw new FinOpsBaseError(`${name} required`, 'VALIDATION_ERROR');
    return value.trim();
  }

  private optionalQuery(req: Request, name: string): string | undefined {
    const value = req.query[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  }

  private parseLimit(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) throw new FinOpsBaseError('limit must be a positive number', 'VALIDATION_ERROR');
    return parsed;
  }

  private parseStatus(value: string | undefined): IngestionJobStatus {
    if (value === 'PENDING' || value === 'RUNNING' || value === 'SUCCESS' || value === 'FAILED' || value === 'CANCELLED' || value === 'SKIPPED') return value;
    throw new FinOpsBaseError('status is not supported', 'VALIDATION_ERROR');
  }

  private parseSourceType(value: string | undefined): IngestionSourceType {
    if (value === 'INVENTORY' || value === 'BILLING_EXPORT' || value === 'TECHNICAL_METRIC' || value === 'AGENT_METRIC') return value;
    throw new FinOpsBaseError('sourceType is not supported', 'VALIDATION_ERROR');
  }

  private respond(res: Response, error: unknown): void {
    respondWithFinOpsError(res, error, 'An unexpected error occurred processing master ingestion jobs', 'master_admin_ingestion_operation_failed');
  }
}
