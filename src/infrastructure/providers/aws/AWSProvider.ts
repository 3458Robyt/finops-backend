/**
 * ═══════════════════════════════════════════════════════════════
 * AWSProvider — Adaptador de AWS Cost Explorer
 * ═══════════════════════════════════════════════════════════════
 *
 * Implementa el patrón Adapter para normalizar los datos de
 * facturación de AWS al formato canónico InternalCostMetric.
 *
 * SDK utilizado: @aws-sdk/client-cost-explorer (AWS SDK v3)
 *
 * ┌──────────────────┐     ┌───────────────┐     ┌──────────────────┐
 * │  AWS Cost        │ ──▶ │  AWSProvider   │ ──▶ │ InternalCost     │
 * │  Explorer API    │     │  (Adapter)     │     │ Metric[]         │
 * └──────────────────┘     └───────────────┘     └──────────────────┘
 *
 * @module infrastructure/providers/aws
 */

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandInput,
  type ResultByTime,
  type Group,
} from '@aws-sdk/client-cost-explorer';

import type { ICloudProvider } from '../../../domain/interfaces/ICloudProvider.js';
import type { InternalCostMetric } from '../../../domain/models/InternalCostMetric.js';
import { ProviderError } from '../../../domain/errors/errors.js';

/**
 * Opciones de configuración para el adaptador AWS.
 */
interface AWSProviderConfig {
  /**
   * Región AWS para el cliente Cost Explorer.
   * Cost Explorer está disponible globalmente, pero la región
   * determina el endpoint utilizado.
   *
   * @default "us-east-1"
   */
  readonly region?: string;

  /**
   * Credenciales AWS explícitas (opcional).
   *
   * ⚠️  SEGURIDAD: En producción, se recomienda usar:
   *   - Variables de entorno (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
   *   - IAM Roles (EC2 Instance Profile, ECS Task Role)
   *   - AWS SSO / Identity Center
   *   - AWS Secrets Manager
   *
   * El SDK v3 resuelve credenciales automáticamente a través de la
   * cadena de proveedores de credenciales (Credential Provider Chain).
   * Solo pasar credenciales explícitas en entornos de desarrollo/testing.
   */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
}

/**
 * Adaptador AWS Cost Explorer que implementa {@link ICloudProvider}.
 *
 * Responsabilidades:
 * 1. Inicializar el cliente AWS Cost Explorer con configuración segura.
 * 2. Construir y ejecutar consultas de costos diarios.
 * 3. Mapear la respuesta bruta de AWS al formato {@link InternalCostMetric}.
 */
export class AWSProvider implements ICloudProvider {
  public readonly providerName = 'aws' as const;

  private readonly client: CostExplorerClient;

  constructor(config: AWSProviderConfig = {}) {
    /**
     * NOTA DE SEGURIDAD:
     * El CostExplorerClient utiliza la Credential Provider Chain por defecto:
     *   1. Variables de entorno (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
     *   2. Shared credentials file (~/.aws/credentials)
     *   3. ECS Container credentials
     *   4. EC2 Instance Metadata (IMDSv2)
     *
     * En producción, se recomienda NO pasar credenciales explícitas.
     * Utilizar IAM Roles o AWS Secrets Manager para la gestión segura.
     */
    this.client = new CostExplorerClient({
      region: config.region ?? 'us-east-1',
      ...(config.credentials !== undefined && {
        credentials: {
          accessKeyId: config.credentials.accessKeyId,
          secretAccessKey: config.credentials.secretAccessKey,
        },
      }),
    });
  }

  /**
   * Obtiene los costos diarios de una cuenta AWS para una fecha específica.
   *
   * Utiliza la API GetCostAndUsage agrupando por servicio (DIMENSION: SERVICE)
   * para obtener un desglose detallado por recurso/servicio.
   *
   * @param accountId - AWS Account ID (12 dígitos).
   * @param date      - Fecha del día a consultar.
   * @returns         - Métricas normalizadas al formato InternalCostMetric[].
   * @throws {ProviderError} Si la comunicación con AWS falla.
   */
  public async fetchDailyCosts(
    accountId: string,
    date: Date,
  ): Promise<InternalCostMetric[]> {
    try {
      const startDate = this.formatDate(date);
      const endDate = this.formatDate(this.addDays(date, 1));

      const input: GetCostAndUsageCommandInput = {
        TimePeriod: {
          Start: startDate,
          End: endDate,
        },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [
          {
            Type: 'DIMENSION',
            Key: 'SERVICE',
          },
        ],
        /**
         * Filtro por cuenta específica para entornos multi-cuenta
         * (AWS Organizations / Consolidated Billing).
         */
        Filter: {
          Dimensions: {
            Key: 'LINKED_ACCOUNT',
            Values: [accountId],
          },
        },
      };

      const command = new GetCostAndUsageCommand(input);
      const response = await this.client.send(command);

      // Mapear los resultados brutos al formato estandarizado
      const metrics: InternalCostMetric[] = [];

      if (response.ResultsByTime) {
        for (const result of response.ResultsByTime) {
          const mapped = this.mapResultToMetrics(result, accountId, date);
          metrics.push(...mapped);
        }
      }

      console.log(
        `[AWSProvider] ✓ Fetched ${metrics.length} cost metrics for account ${accountId} on ${startDate}`,
      );

      return metrics;
    } catch (error: unknown) {
      if (error instanceof ProviderError) {
        throw error;
      }

      const message = error instanceof Error
        ? error.message
        : 'Unknown error during AWS cost data extraction';

      throw new ProviderError(
        this.providerName,
        `Failed to fetch daily costs for account ${accountId}: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Mapea un ResultByTime de AWS al formato InternalCostMetric[].
   *
   * Cada grupo dentro del resultado representa un servicio AWS
   * con su costo asociado para el período.
   */
  private mapResultToMetrics(
    result: ResultByTime,
    accountId: string,
    date: Date,
  ): InternalCostMetric[] {
    const metrics: InternalCostMetric[] = [];

    if (!result.Groups) {
      return metrics;
    }

    for (const group of result.Groups) {
      const metric = this.mapGroupToMetric(group, accountId, date);
      if (metric !== null) {
        metrics.push(metric);
      }
    }

    return metrics;
  }

  /**
   * Mapea un grupo individual de AWS Cost Explorer a InternalCostMetric.
   */
  private mapGroupToMetric(
    group: Group,
    accountId: string,
    date: Date,
  ): InternalCostMetric | null {
    const serviceName = group.Keys?.[0];
    const costData = group.Metrics?.['UnblendedCost'];

    if (serviceName === undefined || costData?.Amount === undefined) {
      return null;
    }

    const amount = parseFloat(costData.Amount);

    // Filtrar costos cero para reducir ruido
    if (amount === 0) {
      return null;
    }

    return {
      resourceId: `arn:aws:${serviceName.toLowerCase().replace(/\s+/g, '-')}:${accountId}`,
      service: serviceName,
      amount,
      currency: costData.Unit ?? 'USD',
      timestamp: date,
      tags: {
        provider: 'aws',
        accountId,
      },
    };
  }

  /**
   * Formatea una fecha al formato YYYY-MM-DD requerido por AWS Cost Explorer.
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0] ?? '';
  }

  /**
   * Suma días a una fecha sin mutar el original (inmutabilidad).
   */
  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }
}
