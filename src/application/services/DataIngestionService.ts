/**
 * ═══════════════════════════════════════════════════════════════
 * DataIngestionService — Orquestador de Ingesta de Datos
 * ═══════════════════════════════════════════════════════════════
 *
 * Servicio de aplicación que orquesta la extracción de datos de
 * costos desde múltiples proveedores de nube. Utiliza Inyección
 * de Dependencias (DI) para recibir los proveedores registrados,
 * siguiendo el Principio de Inversión de Dependencias (DIP).
 *
 * ┌───────────────────┐     ┌──────────────────────────┐
 * │  Presentation     │ ──▶ │  DataIngestionService     │
 * │  (Controller)     │     │  (Orchestrator / Use Case)│
 * └───────────────────┘     └────────┬─────────────────┘
 *                                    │
 *                    ┌───────────────┼───────────────┐
 *                    ▼               ▼               ▼
 *              ┌──────────┐   ┌──────────┐   ┌──────────┐
 *              │ AWS      │   │ OCI      │   │ Future   │
 *              │ Provider │   │ Provider │   │ Provider │
 *              └──────────┘   └──────────┘   └──────────┘
 *
 * @module application/services
 */

import type { ICloudProvider } from '../../domain/interfaces/ICloudProvider.js';
import type { InternalCostMetric } from '../../domain/models/InternalCostMetric.js';
import {
  ProviderNotFoundError,
  IngestionError,
} from '../../domain/errors/errors.js';

/**
 * Resultado de una ejecución de ingesta.
 */
export interface IngestionResult {
  /** Nombre del proveedor utilizado. */
  readonly providerName: string;

  /** ID de la cuenta consultada. */
  readonly accountId: string;

  /** Fecha de los costos consultados. */
  readonly date: Date;

  /** Cantidad de métricas extraídas. */
  readonly metricsCount: number;

  /** Métricas de costo normalizadas. */
  readonly metrics: readonly InternalCostMetric[];

  /** Duración de la extracción en milisegundos. */
  readonly durationMs: number;

  /** Estado de la ingesta. */
  readonly status: 'success' | 'error';

  /** Mensaje de error si la ingesta falló. */
  readonly error?: string;
}

/**
 * Servicio de Ingesta de Datos — Caso de uso principal.
 *
 * Responsabilidades:
 * 1. Gestionar el registro de proveedores de nube (Map-based DI).
 * 2. Orquestar la extracción de costos diarios por proveedor.
 * 3. Preparar las métricas para persistencia en PostgreSQL/TimescaleDB.
 *
 * @example
 * ```typescript
 * const providers = new Map<string, ICloudProvider>([
 *   ['aws', new AWSProvider()],
 *   ['oci', new OCIProvider(config)],
 * ]);
 *
 * const service = new DataIngestionService(providers);
 * const result = await service.runDailyIngestion('aws', '123456789012', new Date());
 * ```
 */
export class DataIngestionService {
  /**
   * Mapa de proveedores registrados.
   * La clave es el nombre del proveedor (e.g., "aws", "oci").
   */
  private readonly providers: ReadonlyMap<string, ICloudProvider>;

  /**
   * @param providers - Mapa de proveedores de nube inyectados.
   *                    La clave debe coincidir con el providerName
   *                    de cada implementación de ICloudProvider.
   */
  constructor(providers: ReadonlyMap<string, ICloudProvider>) {
    if (providers.size === 0) {
      console.warn(
        '[DataIngestionService] ⚠ Initialized with zero providers. ' +
        'No ingestion operations will be possible.',
      );
    }

    this.providers = providers;

    console.log(
      `[DataIngestionService] ✓ Initialized with ${providers.size} provider(s): ` +
      `[${[...providers.keys()].join(', ')}]`,
    );
  }

  /**
   * Ejecuta la ingesta diaria de costos para un proveedor y cuenta específicos.
   *
   * Flujo:
   * 1. Resolver el proveedor registrado por nombre.
   * 2. Invocar fetchDailyCosts para obtener datos brutos normalizados.
   * 3. Log de resultados (preparación para inserción en PostgreSQL).
   *
   * @param providerName - Nombre del proveedor (e.g., "aws", "oci").
   * @param accountId    - ID de cuenta en el proveedor.
   * @param date         - Fecha para consultar los costos diarios.
   * @returns            - Resultado de la ingesta con métricas y metadatos.
   *
   * @throws {ProviderNotFoundError} Si el proveedor no está registrado.
   * @throws {IngestionError}        Si la extracción falla.
   */
  public async runDailyIngestion(
    providerName: string,
    accountId: string,
    date: Date,
  ): Promise<IngestionResult> {
    const startTime = performance.now();

    // ── 1. Resolver proveedor ───────────────────────────────────
    const provider = this.providers.get(providerName);

    if (provider === undefined) {
      throw new ProviderNotFoundError(providerName);
    }

    try {
      // ── 2. Extraer métricas normalizadas ──────────────────────
      console.log(
        `\n${'═'.repeat(60)}\n` +
        `[DataIngestionService] Starting ingestion...\n` +
        `  Provider : ${providerName}\n` +
        `  Account  : ${accountId}\n` +
        `  Date     : ${date.toISOString().split('T')[0] ?? ''}\n` +
        `${'═'.repeat(60)}`,
      );

      const metrics = await provider.fetchDailyCosts(accountId, date);
      const durationMs = Math.round(performance.now() - startTime);

      // ── 3. Log detallado de resultados ────────────────────────
      this.logMetricsSummary(providerName, accountId, metrics, durationMs);

      /**
       * TODO: Inserción en PostgreSQL/TimescaleDB
       * ──────────────────────────────────────────
       * Aquí se invocará el repositorio (ICostRepository.insertBatch)
       * para persistir las métricas en la tabla hypertable de TimescaleDB.
       *
       * Ejemplo futuro:
       *   const insertedCount = await this.costRepository.insertBatch(metrics);
       *   console.log(`[DB] Inserted ${insertedCount} records.`);
       */

      return {
        providerName,
        accountId,
        date,
        metricsCount: metrics.length,
        metrics,
        durationMs,
        status: 'success',
      };
    } catch (error: unknown) {
      const durationMs = Math.round(performance.now() - startTime);
      const message = error instanceof Error
        ? error.message
        : 'Unknown ingestion error';

      console.error(
        `[DataIngestionService] ✗ Ingestion failed for ${providerName}/${accountId}: ${message}`,
      );

      throw new IngestionError(
        providerName,
        accountId,
        message,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Lista los proveedores registrados en el servicio.
   *
   * @returns Arreglo con los nombres de los proveedores disponibles.
   */
  public getRegisteredProviders(): readonly string[] {
    return [...this.providers.keys()];
  }

  /**
   * Imprime un resumen detallado de las métricas extraídas en consola.
   * Preparación visual para validar los datos antes de la inserción en DB.
   */
  private logMetricsSummary(
    providerName: string,
    accountId: string,
    metrics: readonly InternalCostMetric[],
    durationMs: number,
  ): void {
    console.log(
      `\n${'─'.repeat(60)}\n` +
      `[DataIngestionService] Ingestion Complete\n` +
      `  Provider : ${providerName}\n` +
      `  Account  : ${accountId}\n` +
      `  Metrics  : ${metrics.length} records\n` +
      `  Duration : ${durationMs}ms\n` +
      `${'─'.repeat(60)}`,
    );

    if (metrics.length === 0) {
      console.log('  (No cost metrics found for this period)');
      return;
    }

    // Resumen por servicio
    const serviceMap = new Map<string, number>();
    let totalCost = 0;

    for (const metric of metrics) {
      const current = serviceMap.get(metric.service) ?? 0;
      serviceMap.set(metric.service, current + metric.amount);
      totalCost += metric.amount;
    }

    console.log('\n  Cost Breakdown by Service:');
    console.log(`  ${'─'.repeat(50)}`);

    const sortedServices = [...serviceMap.entries()].sort(
      ([, a], [, b]) => b - a,
    );

    for (const [service, cost] of sortedServices) {
      const percentage = ((cost / totalCost) * 100).toFixed(1);
      console.log(
        `  ${service.padEnd(35)} ${cost.toFixed(4).padStart(12)} (${percentage}%)`,
      );
    }

    console.log(`  ${'─'.repeat(50)}`);
    console.log(`  ${'TOTAL'.padEnd(35)} ${totalCost.toFixed(4).padStart(12)}`);
    console.log('');
  }
}
