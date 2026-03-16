/**
 * ═══════════════════════════════════════════════════════════════
 * OCIProvider — Adaptador de Oracle Cloud Infrastructure
 * ═══════════════════════════════════════════════════════════════
 *
 * Implementa el patrón Adapter para normalizar los datos de
 * facturación de Oracle Cloud (OCI) al formato canónico
 * InternalCostMetric.
 *
 * SDK utilizado: oci-sdk (Oracle Cloud Infrastructure SDK for TypeScript/JavaScript)
 *
 * ┌──────────────────┐     ┌───────────────┐     ┌──────────────────┐
 * │  OCI Usage API   │ ──▶ │  OCIProvider   │ ──▶ │ InternalCost     │
 * │  (UsageApi)      │     │  (Adapter)     │     │ Metric[]         │
 * └──────────────────┘     └───────────────┘     └──────────────────┘
 *
 * @module infrastructure/providers/oci
 */

import * as oci from 'oci-sdk';

import type { ICloudProvider } from '../../../domain/interfaces/ICloudProvider.js';
import type { InternalCostMetric } from '../../../domain/models/InternalCostMetric.js';
import { ProviderError } from '../../../domain/errors/errors.js';

/**
 * Tipo alias para el UsageSummary del SDK de OCI.
 * Centraliza la referencia para facilitar actualizaciones del SDK.
 */
type OCIUsageSummary = oci.usageapi.models.UsageSummary;

/**
 * Opciones de configuración para el adaptador OCI.
 */
interface OCIProviderConfig {
  /**
   * Ruta al archivo de configuración OCI.
   * Por defecto usa ~/.oci/config (mismo que el OCI CLI).
   *
   * ⚠️  SEGURIDAD: En producción dentro de OCI, preferir:
   *   - OCI Instance Principals (para compute instances)
   *   - OCI Resource Principals (para functions y containers)
   *   - OCI Vault / Secrets Manager para claves API
   */
  readonly configFilePath?: string;

  /**
   * Perfil dentro del archivo de configuración OCI.
   * @default "DEFAULT"
   */
  readonly profile?: string;
}

/**
 * Adaptador Oracle Cloud Infrastructure que implementa {@link ICloudProvider}.
 *
 * Responsabilidades:
 * 1. Inicializar el cliente OCI UsageApi con configuración segura.
 * 2. Construir y ejecutar consultas de costos diarios vía RequestSummarizedUsages.
 * 3. Mapear la respuesta bruta de OCI al formato {@link InternalCostMetric}.
 */
export class OCIProvider implements ICloudProvider {
  public readonly providerName = 'oci' as const;

  private readonly usageClient: oci.usageapi.UsageapiClient;
  private readonly tenancyId: string;

  constructor(config?: OCIProviderConfig) {
    /**
     * ConfigFileAuthenticationDetailsProvider lee las credenciales
     * desde el archivo ~/.oci/config (formato estándar de OCI CLI).
     *
     * Este es el método de autenticación más robusto y probado
     * del SDK de OCI para Node.js. Soporta claves PKCS#1 y PKCS#8.
     *
     * Formato esperado en ~/.oci/config:
     *   [DEFAULT]
     *   user=ocid1.user.oc1..xxxxx
     *   fingerprint=xx:xx:xx:...
     *   tenancy=ocid1.tenancy.oc1..xxxxx
     *   region=sa-bogota-1
     *   key_file=/path/to/private_key.pem
     */
    const authProvider = new oci.common.ConfigFileAuthenticationDetailsProvider(
      config?.configFilePath ?? undefined,
      config?.profile ?? 'DEFAULT',
    );

    this.tenancyId = authProvider.getTenantId();

    this.usageClient = new oci.usageapi.UsageapiClient({
      authenticationDetailsProvider: authProvider,
    });
  }

  /**
   * Obtiene los costos diarios de un tenant OCI para una fecha específica.
   *
   * Utiliza la API RequestSummarizedUsages agrupando por servicio
   * para obtener el desglose detallado de costos.
   *
   * @param accountId - OCI Tenancy OCID o Compartment OCID.
   * @param date      - Fecha del día a consultar.
   * @returns         - Métricas normalizadas al formato InternalCostMetric[].
   * @throws {ProviderError} Si la comunicación con OCI falla.
   */
  public async fetchDailyCosts(
    accountId: string,
    date: Date,
  ): Promise<InternalCostMetric[]> {
    try {
      const startDate = new Date(date);
      startDate.setUTCHours(0, 0, 0, 0);

      const endDate = new Date(startDate);
      endDate.setUTCDate(endDate.getUTCDate() + 1);

      /**
       * RequestSummarizedUsages consulta la API de uso/costos de OCI.
       * Se agrupa por servicio para obtener el desglose detallado.
       *
       * Documentación: https://docs.oracle.com/en-us/iaas/api/#/en/usage/20200107/UsageSummary/RequestSummarizedUsages
       */
      const request: oci.usageapi.requests.RequestSummarizedUsagesRequest = {
        requestSummarizedUsagesDetails: {
          tenantId: this.tenancyId,
          timeUsageStarted: startDate,
          timeUsageEnded: endDate,
          granularity:
            oci.usageapi.models.RequestSummarizedUsagesDetails.Granularity.Daily,
          queryType:
            oci.usageapi.models.RequestSummarizedUsagesDetails.QueryType.Cost,
          groupBy: ['service'],
        },
      };

      const response = await this.usageClient.requestSummarizedUsages(request);

      // Mapear los resultados brutos al formato estandarizado
      const metrics: InternalCostMetric[] = [];

      if (response.usageAggregation?.items) {
        for (const item of response.usageAggregation.items) {
          const metric = this.mapUsageSummaryToMetric(item, accountId, date);
          if (metric !== null) {
            metrics.push(metric);
          }
        }
      }

      console.log(
        `[OCIProvider] ✓ Fetched ${metrics.length} cost metrics for tenant ${accountId} on ${this.formatDate(date)}`,
      );

      return metrics;
    } catch (error: unknown) {
      if (error instanceof ProviderError) {
        throw error;
      }

      const message = error instanceof Error
        ? error.message
        : 'Unknown error during OCI cost data extraction';

      throw new ProviderError(
        this.providerName,
        `Failed to fetch daily costs for tenant ${accountId}: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Mapea un UsageSummary individual de OCI a InternalCostMetric.
   */
  private mapUsageSummaryToMetric(
    item: OCIUsageSummary,
    accountId: string,
    date: Date,
  ): InternalCostMetric | null {
    const serviceName = item.service;
    const amount = item.computedAmount;

    if (serviceName === undefined || amount === undefined) {
      return null;
    }

    // Filtrar costos cero para reducir ruido
    if (amount === 0) {
      return null;
    }

    const baseTags: Record<string, string> = {
      provider: 'oci',
      tenantId: item.tenantId ?? accountId,
      compartmentId: item.compartmentId ?? accountId,
      ...this.convertTags(item.tags),
    };

    if (item.compartmentName !== undefined) {
      baseTags.compartmentName = item.compartmentName;
    }

    return {
      resourceId: item.resourceId ?? `ocid1.usage.${serviceName.toLowerCase().replace(/\s+/g, '-')}.${accountId}`,
      service: item.service ?? 'Unknown OCI Service',
      amount: item.computedAmount ?? 0,
      currency: item.currency ?? 'USD',
      ...(item.computedQuantity !== undefined && item.computedQuantity !== null ? { usage: item.computedQuantity } : {}),
      ...(item.weight !== undefined && item.weight !== null ? { usageUnit: String(item.weight) } : {}),
      timestamp: date,
      tags: baseTags,
    };
  }

  /**
   * Convierte el formato Tag[] de OCI SDK a Record<string, string>
   * compatible con InternalCostMetric.tags.
   *
   * Cada Tag de OCI tiene { namespace?, key?, value? }.
   * Se convierte a { "namespace/key": "value" } o { "key": "value" }
   * si el namespace no está definido.
   */
  private convertTags(
    tags: oci.usageapi.models.Tag[] | undefined,
  ): Record<string, string> {
    if (tags === undefined || tags.length === 0) {
      return {};
    }

    const result: Record<string, string> = {};

    for (const tag of tags) {
      if (tag.key !== undefined && tag.value !== undefined) {
        const tagKey = tag.namespace !== undefined
          ? `${tag.namespace}/${tag.key}`
          : tag.key;
        result[tagKey] = tag.value;
      }
    }

    return result;
  }

  /**
   * Formatea una fecha al formato YYYY-MM-DD para logging.
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0] ?? '';
  }
}
