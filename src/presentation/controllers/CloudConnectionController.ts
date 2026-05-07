import type { Request, Response } from 'express';
import type { CloudConnectionService } from '../../application/services/CloudConnectionService.js';
import type { IngestionSourceType } from '../../domain/models/CloudConnection.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

export class CloudConnectionController {
  constructor(private readonly cloudConnectionService: CloudConnectionService) {}

  public listProviders = async (_req: Request, res: Response): Promise<void> => {
    try {
      const providers = await this.cloudConnectionService.listProviders();

      res.status(200).json({ success: true, providers });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public listConnections = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const connections = await this.cloudConnectionService.listConnections(tenantId);

      res.status(200).json({ success: true, connections });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public createConnection = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const body = this.requireObjectBody(req.body);

      const connection = await this.cloudConnectionService.registerConnection({
        tenantId,
        providerCode: this.requireString(body['providerCode'], 'providerCode'),
        rootExternalId: this.requireString(body['rootExternalId'], 'rootExternalId'),
        name: this.requireString(body['name'], 'name'),
        ...(typeof body['defaultRegion'] === 'string'
          ? { defaultRegion: body['defaultRegion'] }
          : {}),
        ...(this.isRecord(body['metadata']) ? { metadata: body['metadata'] } : {}),
      });

      res.status(201).json({ success: true, connection });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public provisionConnection = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const body = this.requireObjectBody(req.body);
      const temporaryAdminCredential = body['temporaryAdminCredential'];

      if (!this.isRecord(temporaryAdminCredential)) {
        throw new FinOpsBaseError(
          'temporaryAdminCredential must be an object',
          'VALIDATION_ERROR',
        );
      }

      const result = await this.cloudConnectionService.provisionWithTemporaryAdmin({
        tenantId,
        cloudConnectionId: this.requireParam(req, 'id'),
        temporaryAdminCredential,
      });

      res.status(202).json({ success: true, provisioning: result });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public validateConnection = async (req: Request, res: Response): Promise<void> => {
    try {
      const connection = await this.cloudConnectionService.validateConnection(
        this.requireTenant(req),
        this.requireParam(req, 'id'),
      );

      res.status(200).json({ success: true, connection });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public queueIngestion = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED');
      }

      const body = this.requireObjectBody(req.body);
      const job = await this.cloudConnectionService.queueIngestion({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        cloudConnectionId: this.requireParam(req, 'id'),
        sourceType: this.parseSourceType(body['sourceType']),
        targetStart: this.parseDate(body['targetStart'], 'targetStart'),
        targetEnd: this.parseDate(body['targetEnd'], 'targetEnd'),
      });

      res.status(202).json({ success: true, job });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public getHealth = async (req: Request, res: Response): Promise<void> => {
    try {
      const health = await this.cloudConnectionService.getHealth(
        this.requireTenant(req),
        this.requireParam(req, 'id'),
      );

      res.status(200).json({ success: true, health });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  private requireTenant(req: Request): string {
    if (req.auth === undefined) {
      throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED');
    }

    return req.auth.tenantId;
  }

  private requireParam(req: Request, name: string): string {
    const value = req.params[name];

    if (typeof value !== 'string' || value.trim() === '') {
      throw new FinOpsBaseError(`${name} is required`, 'VALIDATION_ERROR');
    }

    return value.trim();
  }

  private requireObjectBody(body: unknown): Record<string, unknown> {
    if (!this.isRecord(body)) {
      throw new FinOpsBaseError('Request body must be a JSON object', 'VALIDATION_ERROR');
    }

    return body;
  }

  private requireString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new FinOpsBaseError(`${fieldName} is required`, 'VALIDATION_ERROR');
    }

    return value.trim();
  }

  private parseDate(value: unknown, fieldName: string): Date {
    const raw = this.requireString(value, fieldName);
    const parsed = new Date(raw);

    if (Number.isNaN(parsed.getTime())) {
      throw new FinOpsBaseError(`${fieldName} must be an ISO date`, 'VALIDATION_ERROR');
    }

    return parsed;
  }

  private parseSourceType(value: unknown): IngestionSourceType {
    const sourceType = this.requireString(value, 'sourceType');
    const allowed: readonly IngestionSourceType[] = [
      'BILLING_EXPORT',
      'INVENTORY',
      'TECHNICAL_METRIC',
      'AGENT_METRIC',
    ];

    if (!allowed.includes(sourceType as IngestionSourceType)) {
      throw new FinOpsBaseError('sourceType is not supported', 'VALIDATION_ERROR');
    }

    return sourceType as IngestionSourceType;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private respondWithError(res: Response, error: unknown): void {
    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'VALIDATION_ERROR'
          ? 400
          : error.code === 'AUTHENTICATION_REQUIRED'
            ? 401
            : 500;

      res.status(status).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'An unexpected error occurred processing cloud connections',
    });
  }
}
