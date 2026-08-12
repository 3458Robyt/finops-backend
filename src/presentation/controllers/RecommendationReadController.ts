import type { Request, Response } from "express";
import type { IRecommendationRepository } from "../../domain/interfaces/IRecommendationRepository.js";
import {
  parseStatus,
  parseString,
} from "./recommendation/recommendationRequestParsers.js";
import {
  requireAuth,
  requireRecommendationId,
} from "./recommendation/recommendationRequestGuards.js";
import { respondWithFinOpsError } from "../http/finOpsErrorResponse.js";

/** HTTP handlers for recommendation detail and tenant-scoped listing. */
export class RecommendationReadController {
  constructor(
    private readonly recommendationRepository: IRecommendationRepository,
  ) {}

  public getRecommendationById = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;

      const recommendationId = requireRecommendationId(res, req.params["id"]);
      if (recommendationId === undefined) return;

      const recommendation = await this.recommendationRepository.findById(
        auth.tenantId,
        recommendationId,
      );

      if (recommendation === null) {
        res.status(404).json({
          success: false,
          error: "Recommendation not found",
          code: "NOT_FOUND",
        });
        return;
      }

      res.status(200).json({ success: true, recommendation });
    } catch (error: unknown) {
      respondWithFinOpsError(
        res,
        error,
        "No fue posible cargar el detalle de la oportunidad.",
        "recommendation_detail",
        req.path,
      );
    }
  };

  public getRecommendations = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;

      const status = parseStatus(req.query["status"]);
      const cloudAccountId = parseString(req.query["cloudAccountId"]);
      const externalResourceId = parseString(req.query["externalResourceId"]);
      const cloudResourceId = parseString(req.query["cloudResourceId"]);
      const recommendations = await this.recommendationRepository.findByTenant({
        tenantId: auth.tenantId,
        ...(status !== undefined ? { status } : {}),
        ...(cloudAccountId !== undefined ? { cloudAccountId } : {}),
        ...(externalResourceId !== undefined ? { externalResourceId } : {}),
        ...(cloudResourceId !== undefined ? { cloudResourceId } : {}),
      });

      res.status(200).json({
        success: true,
        recommendations,
        meta: {
          tenantId: auth.tenantId,
          count: recommendations.length,
          ...(status !== undefined ? { status } : {}),
          ...(cloudAccountId !== undefined ? { cloudAccountId } : {}),
          ...(externalResourceId !== undefined ? { externalResourceId } : {}),
          ...(cloudResourceId !== undefined ? { cloudResourceId } : {}),
        },
      });
    } catch (error: unknown) {
      respondWithFinOpsError(
        res,
        error,
        "No fue posible cargar las oportunidades.",
        "recommendations_list",
        req.path,
      );
    }
  };
}
