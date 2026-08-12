import type { Request, Response } from "express";
import type { ValueRealizationService } from "../../application/services/ValueRealizationService.js";
import type {
  CreateSavingsMeasurementInput,
  IRecommendationRepository,
} from "../../domain/interfaces/IRecommendationRepository.js";
import { safeErrorMessage } from "../../application/observability/safeError.js";
import {
  parseString,
  parseNumber,
  readBodyValue,
} from "./recommendation/recommendationRequestParsers.js";
import {
  requireAuth,
  requireRecommendationId,
  requireSavingsMeasurementRole,
  requireSavingsVerificationRole,
} from "./recommendation/recommendationRequestGuards.js";
import { respondWithRecommendationError } from "./recommendation/recommendationErrorResponse.js";

/** HTTP handlers for savings measurement and verification lifecycle. */
export class RecommendationSavingsController {
  constructor(
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly valueRealizationService?: ValueRealizationService,
  ) {}

  public getSavingsMeasurementReadiness = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;
      const recommendationId = requireRecommendationId(res, req.params["id"]);
      if (recommendationId === undefined) return;
      const readiness =
        await this.recommendationRepository.getSavingsMeasurementReadiness(
          auth.tenantId,
          recommendationId,
        );
      res.status(200).json({ success: true, readiness });
    } catch (error: unknown) {
      respondWithRecommendationError(
        res,
        error,
        "An unexpected error occurred loading savings measurement readiness",
      );
    }
  };

  public createSavingsMeasurement = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;
      if (!requireSavingsMeasurementRole(res, auth)) return;
      const recommendationId = requireRecommendationId(res, req.params["id"]);
      const manualExecutionId = parseString(
        readBodyValue(req.body, "manualExecutionId"),
      );
      if (recommendationId === undefined || manualExecutionId === undefined) {
        res
          .status(400)
          .json({
            success: false,
            error:
              "El id de la recomendación y manualExecutionId son obligatorios",
            code: "VALIDATION_ERROR",
          });
        return;
      }
      const windowDays = parseNumber(readBodyValue(req.body, "windowDays"));
      const input: CreateSavingsMeasurementInput = {
        tenantId: auth.tenantId,
        recommendationId,
        manualExecutionId,
        requestedByUserId: auth.userId,
        ...(windowDays !== undefined ? { windowDays } : {}),
      };
      const measurement =
        await this.recommendationRepository.createSavingsMeasurement(input);
      void this.valueRealizationService
        ?.notifyMeasurement(measurement)
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              level: "warn",
              event: "savings_measurement_notification_failed",
              error: safeErrorMessage(error),
            }),
          );
        });
      res.status(201).json({ success: true, measurement });
    } catch (error: unknown) {
      respondWithRecommendationError(
        res,
        error,
        "No fue posible calcular la medición de ahorro",
      );
    }
  };

  public listSavingsMeasurements = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;
      const recommendationId = requireRecommendationId(res, req.params["id"]);
      if (recommendationId === undefined) return;
      const measurements =
        await this.recommendationRepository.findSavingsMeasurementsByRecommendation(
          auth.tenantId,
          recommendationId,
        );
      res
        .status(200)
        .json({
          success: true,
          measurements,
          meta: { count: measurements.length },
        });
    } catch (error: unknown) {
      respondWithRecommendationError(
        res,
        error,
        "No fue posible cargar las mediciones de ahorro",
      );
    }
  };

  public getSavingsMeasurement = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;
      const recommendationId = requireRecommendationId(res, req.params["id"]);
      const measurementId = parseString(req.params["measurementId"]);
      if (recommendationId === undefined || measurementId === undefined) return;
      const measurement =
        await this.recommendationRepository.findSavingsMeasurementById(
          auth.tenantId,
          recommendationId,
          measurementId,
        );
      if (measurement === null) {
        res
          .status(404)
          .json({
            success: false,
            error: "No se encontró la medición de ahorro",
            code: "NOT_FOUND",
          });
        return;
      }
      res.status(200).json({ success: true, measurement });
    } catch (error: unknown) {
      respondWithRecommendationError(
        res,
        error,
        "No fue posible cargar la medición de ahorro",
      );
    }
  };

  public verifySavingsMeasurement = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;
      if (!requireSavingsVerificationRole(res, auth)) return;
      const recommendationId = requireRecommendationId(res, req.params["id"]);
      const measurementId = parseString(req.params["measurementId"]);
      if (recommendationId === undefined || measurementId === undefined) {
        res
          .status(400)
          .json({
            success: false,
            error:
              "El id de la recomendación y de la medición son obligatorios",
            code: "VALIDATION_ERROR",
          });
        return;
      }
      const note = parseString(readBodyValue(req.body, "note"));
      const measurement =
        await this.recommendationRepository.verifySavingsMeasurement({
          tenantId: auth.tenantId,
          recommendationId,
          measurementId,
          userId: auth.userId,
          ...(note !== undefined ? { note } : {}),
        });
      void this.valueRealizationService
        ?.notifyMeasurement(measurement)
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              level: "warn",
              event: "verified_savings_notification_failed",
              error: safeErrorMessage(error),
            }),
          );
        });
      res.status(200).json({ success: true, measurement });
    } catch (error: unknown) {
      respondWithRecommendationError(
        res,
        error,
        "No fue posible verificar la medición de ahorro",
      );
    }
  };

  public rejectSavingsMeasurement = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;
      if (!requireSavingsVerificationRole(res, auth)) return;
      const recommendationId = requireRecommendationId(res, req.params["id"]);
      const measurementId = parseString(req.params["measurementId"]);
      const reason = parseString(readBodyValue(req.body, "reason"));
      if (
        recommendationId === undefined ||
        measurementId === undefined ||
        reason === undefined
      ) {
        res
          .status(400)
          .json({
            success: false,
            error:
              "El id de la recomendación, de la medición y el motivo son obligatorios",
            code: "VALIDATION_ERROR",
          });
        return;
      }
      const measurement =
        await this.recommendationRepository.rejectSavingsMeasurement({
          tenantId: auth.tenantId,
          recommendationId,
          measurementId,
          userId: auth.userId,
          reason,
        });
      void this.valueRealizationService
        ?.notifyMeasurement(measurement)
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              level: "warn",
              event: "rejected_savings_notification_failed",
              error: safeErrorMessage(error),
            }),
          );
        });
      res.status(200).json({ success: true, measurement });
    } catch (error: unknown) {
      respondWithRecommendationError(
        res,
        error,
        "No fue posible rechazar la medición de ahorro",
      );
    }
  };
}
