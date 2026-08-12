import type {
  AdoptionKpis,
  CreateSavingsMeasurementInput,
  IRecommendationRepository,
  RecommendationSavingsMeasurement,
  RejectSavingsMeasurementInput,
  SavingsKpis,
  SavingsMeasurementReadiness,
  VerifySavingsMeasurementInput,
} from "../../domain/interfaces/IRecommendationRepository.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import {
  computeAdoptionKpis,
  computeSavingsKpis,
} from "./queries/recommendationKpiQueries.js";
import {
  createSavingsMeasurement,
  findSavingsMeasurementById,
  findSavingsMeasurementsByRecommendation,
  getSavingsMeasurementReadiness,
  rejectSavingsMeasurement,
  verifySavingsMeasurement,
} from "./queries/recommendationSavingsMeasurementQueries.js";

/** Reads and mutates savings realization data related to recommendations. */
export class PrismaRecommendationSavingsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async getSavingsKpis(tenantId: string): Promise<SavingsKpis> {
    return computeSavingsKpis(this.prisma, tenantId);
  }

  /**
   * Calcula los KPIs de adopción de un tenant (totales por estado y tasas de
   * aceptación, rechazo y ejecución).
   *
   * Agrupa las recomendaciones por estado (`groupBy`) y deriva los conteos. Las
   * tasas se calculan de forma defensiva sobre el conjunto de recomendaciones ya
   * "decididas" (aprobadas + rechazadas + completadas), devolviendo 0 cuando el
   * denominador es 0 para evitar divisiones por cero:
   * - `acceptanceRate`: (aprobadas + completadas) / decididas.
   * - `rejectionRate`: rechazadas / decididas.
   * - `executionRate`: completadas / total de recomendaciones.
   *
   * @param tenantId Tenant del que se calculan los KPIs (aislamiento
   *   multi-tenant).
   * @returns KPIs de adopción de dominio.
   */

  public async getAdoptionKpis(tenantId: string): Promise<AdoptionKpis> {
    return computeAdoptionKpis(this.prisma, tenantId);
  }

  public async getSavingsMeasurementReadiness(
    tenantId: string,
    recommendationId: string,
  ): Promise<SavingsMeasurementReadiness> {
    return getSavingsMeasurementReadiness(
      this.prisma,
      tenantId,
      recommendationId,
    );
  }

  public async createSavingsMeasurement(
    input: CreateSavingsMeasurementInput,
  ): Promise<RecommendationSavingsMeasurement> {
    return createSavingsMeasurement(this.prisma, input);
  }

  public async findSavingsMeasurementsByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationSavingsMeasurement[]> {
    return findSavingsMeasurementsByRecommendation(
      this.prisma,
      tenantId,
      recommendationId,
    );
  }

  public async findSavingsMeasurementById(
    tenantId: string,
    recommendationId: string,
    measurementId: string,
  ): Promise<RecommendationSavingsMeasurement | null> {
    return findSavingsMeasurementById(
      this.prisma,
      tenantId,
      recommendationId,
      measurementId,
    );
  }

  public async verifySavingsMeasurement(
    input: VerifySavingsMeasurementInput,
  ): Promise<RecommendationSavingsMeasurement> {
    return verifySavingsMeasurement(this.prisma, input);
  }

  public async rejectSavingsMeasurement(
    input: RejectSavingsMeasurementInput,
  ): Promise<RecommendationSavingsMeasurement> {
    return rejectSavingsMeasurement(this.prisma, input);
  }
}
