import type { Request, Response } from "express";
import type { CloudConnectionService } from "../../application/services/CloudConnectionService.js";
import { FinOpsBaseError } from "../../domain/errors/errors.js";
import { CloudConnectionControllerSupport } from "./CloudConnectionControllerSupport.js";

export class CloudConnectionManagementController extends CloudConnectionControllerSupport {
  constructor(private readonly cloudConnectionService: CloudConnectionService) {
    super();
  }

  public listProviders = async (
    _req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const providers = await this.cloudConnectionService.listProviders();

      res.status(200).json({ success: true, providers });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public listConnections = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const connections =
        await this.cloudConnectionService.listConnections(tenantId);

      res.status(200).json({ success: true, connections });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public createConnection = async (
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

      const connection = await this.cloudConnectionService.registerConnection({
        tenantId,
        userId: req.auth.userId,
        providerCode: this.requireString(body["providerCode"], "providerCode"),
        rootExternalId: this.requireString(
          body["rootExternalId"],
          "rootExternalId",
        ),
        name: this.requireString(body["name"], "name"),
        ...(typeof body["defaultRegion"] === "string"
          ? { defaultRegion: body["defaultRegion"] }
          : {}),
      });

      res.status(201).json({ success: true, connection });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public getOnboardingDetail = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const onboarding = await this.cloudConnectionService.getOnboardingDetail(
        this.requireTenant(req),
        this.requireParam(req, "id"),
      );
      res.status(200).json({ success: true, onboarding });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public updateConnection = async (
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
      const connection = await this.cloudConnectionService.updateConnection({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        cloudConnectionId: this.requireParam(req, "id"),
        name: this.requireString(body["name"], "name"),
        ...(typeof body["defaultRegion"] === "string"
          ? { defaultRegion: body["defaultRegion"] }
          : {}),
      });
      res.status(200).json({ success: true, connection });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public setConnectionStatus = async (
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
      const status = body["status"];
      if (status !== "ACTIVE" && status !== "DISABLED") {
        throw new FinOpsBaseError(
          "El estado debe ser ACTIVE o DISABLED.",
          "VALIDATION_ERROR",
        );
      }
      const connection = await this.cloudConnectionService.setConnectionStatus({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        cloudConnectionId: this.requireParam(req, "id"),
        status,
      });
      res.status(200).json({ success: true, connection });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public storeCredential = async (
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
      const payload = body["payload"];
      if (!this.isRecord(payload)) {
        throw new FinOpsBaseError(
          "La credencial debe enviarse como un objeto JSON.",
          "VALIDATION_ERROR",
        );
      }

      const credential =
        await this.cloudConnectionService.storeOperationalCredential({
          tenantId: this.requireTenant(req),
          userId: req.auth.userId,
          cloudConnectionId: this.requireParam(req, "id"),
          purpose: this.parseCredentialPurpose(body["purpose"]),
          label: this.requireString(body["label"], "label"),
          payload,
        });
      res.status(201).json({ success: true, credential });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public revokeCredential = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      if (req.auth === undefined)
        throw new FinOpsBaseError(
          "Debes iniciar sesión para continuar.",
          "AUTHENTICATION_REQUIRED",
        );
      const credential =
        await this.cloudConnectionService.revokeOperationalCredential(
          this.requireTenant(req),
          this.requireParam(req, "id"),
          this.requireParam(req, "credentialId"),
          req.auth.userId,
        );
      res.status(200).json({ success: true, credential });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public validateConnection = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      if (req.auth === undefined)
        throw new FinOpsBaseError(
          "Debes iniciar sesión para continuar.",
          "AUTHENTICATION_REQUIRED",
        );
      const validation = await this.cloudConnectionService.validateConnection({
        tenantId: this.requireTenant(req),
        cloudConnectionId: this.requireParam(req, "id"),
        userId: req.auth.userId,
      });

      res.status(200).json({ success: true, validation });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public previewFocusSource = async (
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
      const limit = this.parseOptionalNumber(body["limit"], "limit");
      const preview = await this.cloudConnectionService.previewFocusSource({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        cloudConnectionId: this.requireParam(req, "id"),
        ...(limit !== undefined ? { limit } : {}),
      });
      res.status(200).json({ success: true, preview });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public activateConnection = async (
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
      const billingLookbackDays = this.parseOptionalNumber(
        body["billingLookbackDays"],
        "billingLookbackDays",
      );
      const metricLookbackDays = this.parseOptionalNumber(
        body["metricLookbackDays"],
        "metricLookbackDays",
      );
      const metricWindowHours = this.parseOptionalNumber(
        body["metricWindowHours"],
        "metricWindowHours",
      );
      const activation = await this.cloudConnectionService.activateConnection({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        cloudConnectionId: this.requireParam(req, "id"),
        ...(billingLookbackDays !== undefined ? { billingLookbackDays } : {}),
        ...(metricLookbackDays !== undefined ? { metricLookbackDays } : {}),
        ...(metricWindowHours !== undefined ? { metricWindowHours } : {}),
      });
      res.status(202).json({ success: true, activation });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public configureBillingSource = async (
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
      const billingSource =
        await this.cloudConnectionService.configureBillingSource({
          tenantId: this.requireTenant(req),
          userId: req.auth.userId,
          cloudConnectionId: this.requireParam(req, "id"),
          mode: this.parseBillingSourceMode(body["mode"]),
        });

      res.status(200).json({ success: true, billingSource });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public configureMetricDefinitions = async (
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
      const definitions = body["definitions"];
      if (!Array.isArray(definitions)) {
        throw new FinOpsBaseError(
          "definitions debe ser un arreglo.",
          "VALIDATION_ERROR",
        );
      }
      const result =
        await this.cloudConnectionService.configureMetricDefinitions({
          tenantId: req.auth.tenantId,
          userId: req.auth.userId,
          cloudConnectionId: this.requireParam(req, "id"),
          definitions,
          replace: body["replace"] !== false,
        });
      res.status(200).json({ success: true, metricDefinitions: result });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };
}
