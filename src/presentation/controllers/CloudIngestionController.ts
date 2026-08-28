import type { Request, Response } from "express";
import type { CloudConnectionService } from "../../application/services/CloudConnectionService.js";
import { FinOpsBaseError } from "../../domain/errors/errors.js";
import { CloudConnectionControllerSupport } from "./CloudConnectionControllerSupport.js";

export class CloudIngestionController extends CloudConnectionControllerSupport {
  constructor(private readonly cloudConnectionService: CloudConnectionService) {
    super();
  }

  public queueIngestion = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      if (req.auth === undefined) {
        throw new FinOpsBaseError(
          "Debes iniciar sesión para continuar.",
          "AUTHENTICATION_REQUIRED",
        );
      }

      const body = this.requireObjectBody(req.body);
      const job = await this.cloudConnectionService.queueIngestion({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        cloudConnectionId: this.requireParam(req, "id"),
        sourceType: this.parseSourceType(body["sourceType"]),
        targetStart: this.parseDate(body["targetStart"], "targetStart"),
        targetEnd: this.parseDate(body["targetEnd"], "targetEnd"),
      });

      res.status(202).json({ success: true, job });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public queueTenantIngestion = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      if (req.auth === undefined) {
        throw new FinOpsBaseError(
          "Debes iniciar sesión para continuar.",
          "AUTHENTICATION_REQUIRED",
        );
      }

      const body = this.requireObjectBody(req.body);
      const job = await this.cloudConnectionService.queueIngestion({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        cloudConnectionId: this.requireString(
          body["cloudConnectionId"],
          "cloudConnectionId",
        ),
        sourceType: this.parseSourceType(body["sourceType"]),
        targetStart: this.parseDate(body["targetStart"], "targetStart"),
        targetEnd: this.parseDate(body["targetEnd"], "targetEnd"),
      });

      res.status(202).json({ success: true, job });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public queueTechnicalBackfill = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      if (req.auth === undefined) {
        throw new FinOpsBaseError(
          "Debes iniciar sesión para continuar.",
          "AUTHENTICATION_REQUIRED",
        );
      }

      const body = this.requireObjectBody(req.body);
      const cloudConnectionId = this.requireString(
        body["cloudConnectionId"],
        "cloudConnectionId",
      );
      const lookbackDays = this.parseOptionalNumber(
        body["lookbackDays"],
        "lookbackDays",
      );
      const windowHours = this.parseOptionalNumber(
        body["windowHours"],
        "windowHours",
      );

      const backfill =
        await this.cloudConnectionService.queueTechnicalMetricBackfill({
          tenantId: req.auth.tenantId,
          userId: req.auth.userId,
          cloudConnectionId,
          ...(lookbackDays !== undefined ? { lookbackDays } : {}),
          ...(windowHours !== undefined ? { windowHours } : {}),
        });

      res.status(202).json({ success: true, backfill });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public getHealth = async (req: Request, res: Response): Promise<void> => {
    try {
      const health = await this.cloudConnectionService.getHealth(
        this.requireTenant(req),
        this.requireParam(req, "id"),
      );

      res.status(200).json({ success: true, health });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public listIngestionHistory = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const jobs = await this.cloudConnectionService.listIngestionHistory(
        tenantId,
        this.parseLimit(req.query["limit"]),
        req.query['includeArchived'] === 'true',
      );

      res.status(200).json({ success: true, jobs });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public listDataQuality = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const checks = await this.cloudConnectionService.listDataQualityChecks(
        tenantId,
        this.parseLimit(req.query["limit"]),
      );

      res.status(200).json({ success: true, checks });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public getIngestionReadiness = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const readiness =
        await this.cloudConnectionService.getIngestionReadiness(tenantId);

      res.status(200).json({ success: true, readiness });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public listMetricCoverage = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const startDate = this.parseOptionalDate(req.query['startDate'], 'startDate');
      const endDate = this.parseOptionalDate(req.query['endDate'], 'endDate');
      if (startDate !== undefined && endDate !== undefined && endDate <= startDate) {
        throw new FinOpsBaseError('La fecha final debe ser posterior a la fecha inicial.', 'VALIDATION_ERROR');
      }
      const status = this.parseMetricCoverageStatus(req.query['status']);
      const coverage = await this.cloudConnectionService.listMetricCoverage(
        tenantId,
        this.requireString(req.query['connectionId'], 'connectionId'),
        {
          ...(startDate === undefined ? {} : { startDate }),
          ...(endDate === undefined ? {} : { endDate }),
          ...(status === undefined ? {} : { status }),
          limit: Math.min(500, Math.max(1, this.parseLimit(req.query['limit']) ?? 100)),
        },
      );
      res.status(200).json({ success: true, coverage });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public configureFocusSource = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      if (req.auth === undefined)
        throw new FinOpsBaseError(
          "Debes iniciar sesión para continuar.",
          "AUTHENTICATION_REQUIRED",
        );
      const tenantId = this.requireTenant(req);
      const body = this.requireObjectBody(req.body);
      const focusSource =
        await this.cloudConnectionService.configureFocusSource({
          tenantId,
          userId: req.auth.userId,
          cloudConnectionId: this.requireString(
            body["cloudConnectionId"],
            "cloudConnectionId",
          ),
          mode: this.parseFocusSourceMode(body["mode"]),
          values: this.requireStringRecord(body["values"], "values"),
          replace: body["replace"] === true,
        });

      res.status(200).json({ success: true, focusSource });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public retryFailedIngestionJobs = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      if (req.auth === undefined)
        throw new FinOpsBaseError(
          "Debes iniciar sesión para continuar.",
          "AUTHENTICATION_REQUIRED",
        );
      const body = this.requireObjectBody(req.body);
      const jobs = await this.cloudConnectionService.retryFailedIngestionJobs({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        cloudConnectionId: this.requireParam(req, "id"),
        sourceType: this.parseSourceType(body["sourceType"]),
      });
      res.status(202).json({ success: true, jobs });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public cancelPendingIngestionJobs = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      if (req.auth === undefined)
        throw new FinOpsBaseError(
          "Debes iniciar sesión para continuar.",
          "AUTHENTICATION_REQUIRED",
        );
      const body = this.requireObjectBody(req.body);
      const sourceType = this.parseSourceType(body["sourceType"]);
      const cancelled =
        await this.cloudConnectionService.cancelPendingIngestionJobs({
          tenantId: req.auth.tenantId,
          userId: req.auth.userId,
          cloudConnectionId: this.requireParam(req, "id"),
          sourceType,
        });
      res.status(200).json({ success: true, sourceType, cancelled });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public getIngestionJob = async (req: Request, res: Response): Promise<void> => {
    try {
      const job = await this.cloudConnectionService.getIngestionJob(
        this.requireTenant(req),
        this.requireParam(req, 'jobId'),
      );
      res.status(200).json({ success: true, job });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public cancelIngestionJob = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) throw new FinOpsBaseError('Debes iniciar sesión para continuar.', 'AUTHENTICATION_REQUIRED');
      const job = await this.cloudConnectionService.cancelIngestionJob(
        req.auth.tenantId,
        this.requireParam(req, 'jobId'),
        req.auth.userId,
      );
      res.status(200).json({ success: true, job });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public archiveIngestionJob = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) throw new FinOpsBaseError('Debes iniciar sesión para continuar.', 'AUTHENTICATION_REQUIRED');
      const job = await this.cloudConnectionService.archiveIngestionJob(
        req.auth.tenantId,
        this.requireParam(req, 'jobId'),
        req.auth.userId,
      );
      res.status(200).json({ success: true, job });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };
}
