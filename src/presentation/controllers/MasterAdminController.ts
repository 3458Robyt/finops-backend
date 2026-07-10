import type { Request, Response } from 'express';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { MasterAdminService } from '../../application/services/MasterAdminService.js';
import type { TenantAccessRole, TenantStatus, UserRole } from '../../generated/prisma/client.js';

export class MasterAdminController {
  public constructor(private readonly masterAdminService: MasterAdminService) {}

  public listTenants = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenants = await this.masterAdminService.listTenants(this.requireActor(req));
      res.status(200).json({ success: true, tenants });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public createTenant = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = this.requireObjectBody(req.body);
      const tenant = await this.masterAdminService.createTenant({
        actorUserId: this.requireActor(req),
        name: this.requireString(body['name'], 'name'),
        ...(typeof body['slug'] === 'string' ? { slug: body['slug'] } : {}),
        request: this.requestMetadata(req),
      });
      res.status(201).json({ success: true, tenant });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public updateTenant = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = this.requireObjectBody(req.body);
      const tenant = await this.masterAdminService.updateTenant({
        actorUserId: this.requireActor(req),
        tenantId: this.requireParam(req, 'tenantId'),
        ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
        ...(body['status'] !== undefined ? { status: this.parseTenantStatus(body['status']) } : {}),
        request: this.requestMetadata(req),
      });
      res.status(200).json({ success: true, tenant });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public listUsers = async (req: Request, res: Response): Promise<void> => {
    try {
      const users = await this.masterAdminService.listStaffUsers(this.requireActor(req));
      res.status(200).json({ success: true, users });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public createUser = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = this.requireObjectBody(req.body);
      const user = await this.masterAdminService.createStaffUser({
        actorUserId: this.requireActor(req),
        name: this.requireString(body['name'], 'name'),
        email: this.requireString(body['email'], 'email'),
        role: this.parseUserRole(body['role']),
        temporaryPassword: this.requireString(body['temporaryPassword'], 'temporaryPassword'),
        request: this.requestMetadata(req),
      });
      res.status(201).json({ success: true, user });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public listAssignments = async (req: Request, res: Response): Promise<void> => {
    try {
      const assignments = await this.masterAdminService.listAssignments(this.requireActor(req));
      res.status(200).json({ success: true, assignments });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public assignTenant = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = this.requireObjectBody(req.body);
      const assignment = await this.masterAdminService.assignTenant({
        actorUserId: this.requireActor(req),
        tenantId: this.requireParam(req, 'tenantId'),
        userId: this.requireParam(req, 'userId'),
        accessRole: this.parseAccessRole(body['accessRole']),
        request: this.requestMetadata(req),
      });
      res.status(200).json({ success: true, assignment });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public revokeTenant = async (req: Request, res: Response): Promise<void> => {
    try {
      const assignment = await this.masterAdminService.revokeTenant({
        actorUserId: this.requireActor(req),
        tenantId: this.requireParam(req, 'tenantId'),
        userId: this.requireParam(req, 'userId'),
        request: this.requestMetadata(req),
      });
      res.status(200).json({ success: true, assignment });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  private requireActor(req: Request): string {
    if (req.auth === undefined) {
      throw new FinOpsBaseError('Authentication required', 'AUTHENTICATION_REQUIRED');
    }

    return req.auth.userId;
  }

  private requireParam(req: Request, name: string): string {
    const value = req.params[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new FinOpsBaseError(`${name} required`, 'VALIDATION_ERROR');
    }

    return value.trim();
  }

  private requireObjectBody(body: unknown): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new FinOpsBaseError('Request body must be a JSON object', 'VALIDATION_ERROR');
    }

    return body as Record<string, unknown>;
  }

  private requireString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new FinOpsBaseError(`${fieldName} must be a non-empty string`, 'VALIDATION_ERROR');
    }

    return value;
  }

  private parseTenantStatus(value: unknown): TenantStatus {
    if (value !== 'ACTIVE' && value !== 'SUSPENDED') {
      throw new FinOpsBaseError('status must be ACTIVE or SUSPENDED', 'VALIDATION_ERROR');
    }

    return value;
  }

  private parseUserRole(value: unknown): UserRole {
    if (value !== 'OPERATOR_ADMIN' && value !== 'FINOPS_TECHNICIAN') {
      throw new FinOpsBaseError('role must be OPERATOR_ADMIN or FINOPS_TECHNICIAN', 'VALIDATION_ERROR');
    }

    return value;
  }

  private parseAccessRole(value: unknown): TenantAccessRole {
    if (value !== 'TECHNICIAN' && value !== 'LEAD_TECHNICIAN' && value !== 'OPERATOR_ADMIN') {
      throw new FinOpsBaseError('accessRole must be TECHNICIAN, LEAD_TECHNICIAN or OPERATOR_ADMIN', 'VALIDATION_ERROR');
    }

    return value;
  }

  private requestMetadata(req: Request): { readonly ipAddress?: string; readonly userAgent?: string } {
    const userAgent = req.get('user-agent');
    return {
      ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
      ...(userAgent !== undefined ? { userAgent } : {}),
    };
  }

  private respondWithError(res: Response, error: unknown): void {
    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'VALIDATION_ERROR'
          ? 400
          : error.code === 'AUTHENTICATION_REQUIRED'
            ? 401
            : error.code === 'AUTHORIZATION_FAILED'
              ? 403
              : error.code === 'CONFLICT'
                ? 409
                : 500;

      res.status(status).json({ success: false, error: error.message, code: error.code });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'An unexpected error occurred processing master administration',
    });
  }
}
