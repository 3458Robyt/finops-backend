import type { Request, Response } from 'express';
import type { CloudConnectionService } from '../../application/services/CloudConnectionService.js';
import type { IngestionSourceType } from '../../domain/models/CloudConnection.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

/**
 * Controlador de la capa de presentación para las conexiones a proveedores de
 * nube (montado en `/api/v1/cloud-connections`). Traduce las peticiones HTTP
 * hacia los casos de uso de conexión e ingesta y serializa la respuesta.
 *
 * Gestiona el catálogo de proveedores, el alta y listado de conexiones, el
 * aprovisionamiento con credencial administradora temporal, la validación de la
 * conexión, el encolado de trabajos de ingesta y el estado de salud de la ingesta.
 *
 * Servicios que utiliza:
 * - {@link CloudConnectionService}: proveedores, conexiones, aprovisionamiento,
 *   validación, ingesta y salud.
 *
 * Salvo el catálogo de proveedores, las operaciones se acotan al tenant del
 * usuario autenticado.
 */
export class CloudConnectionController {
  constructor(private readonly cloudConnectionService: CloudConnectionService) {}

  /**
   * Lista los proveedores de nube soportados (catálogo global).
   *
   * Sirve: GET /api/v1/cloud-connections/providers
   * Autenticación: requerida por la ruta (no usa datos del tenant).
   *
   * Respuestas:
   * - 200: `{ success: true, providers }`.
   * - 500: error inesperado (u otros códigos de dominio según {@link respondWithError}).
   */
  public listProviders = async (_req: Request, res: Response): Promise<void> => {
    try {
      const providers = await this.cloudConnectionService.listProviders();

      res.status(200).json({ success: true, providers });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  /**
   * Lista las conexiones a la nube registradas por el tenant autenticado.
   *
   * Sirve: GET /api/v1/cloud-connections
   * Autenticación: requerida. Usa `req.auth.tenantId` para acotar el listado.
   *
   * Respuestas:
   * - 200: `{ success: true, connections }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado (ver {@link respondWithError}).
   */
  public listConnections = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const connections = await this.cloudConnectionService.listConnections(tenantId);

      res.status(200).json({ success: true, connections });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  /**
   * Registra una nueva conexión a un proveedor de nube para el tenant.
   *
   * Sirve: POST /api/v1/cloud-connections
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Cuerpo (`req.body`, objeto JSON):
   * - `providerCode` (obligatorio): código del proveedor de nube.
   * - `rootExternalId` (obligatorio): identificador externo raíz de la cuenta.
   * - `name` (obligatorio): nombre descriptivo de la conexión.
   * - `defaultRegion` (opcional): región por defecto.
   * - `metadata` (opcional): objeto con metadatos adicionales.
   *
   * Respuestas:
   * - 201: `{ success: true, connection }` con la conexión creada.
   * - 400 VALIDATION_ERROR: cuerpo no objeto o campos obligatorios ausentes.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 404 NOT_FOUND / 500: otros errores de dominio (ver {@link respondWithError}).
   */
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

  /**
   * Aprovisiona una conexión usando una credencial administradora temporal
   * (operación asíncrona).
   *
   * Sirve: POST /api/v1/cloud-connections/:id/provision
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la conexión a aprovisionar.
   *
   * Cuerpo (`req.body`, objeto JSON):
   * - `temporaryAdminCredential` (obligatorio): objeto con la credencial administradora temporal.
   *
   * Respuestas:
   * - 202: `{ success: true, provisioning }` (aprovisionamiento aceptado/encolado).
   * - 400 VALIDATION_ERROR: cuerpo no objeto, `id` ausente o credencial no es objeto.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 404 NOT_FOUND / 500: otros errores de dominio (ver {@link respondWithError}).
   */
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

  /**
   * Valida una conexión existente comprobando su credencial/acceso.
   *
   * Sirve: POST /api/v1/cloud-connections/:id/validate
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la conexión a validar.
   *
   * Respuestas:
   * - 200: `{ success: true, connection }` con la conexión validada.
   * - 400 VALIDATION_ERROR: `id` ausente.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 404 NOT_FOUND / 500: otros errores de dominio (ver {@link respondWithError}).
   */
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

  /**
   * Encola un trabajo de ingesta de datos para una conexión, en un rango de
   * fechas y para un tipo de fuente determinado (operación asíncrona).
   *
   * Sirve: POST /api/v1/cloud-connections/:id/ingestion-jobs
   * Autenticación: requerida. Usa `req.auth.tenantId` y `req.auth.userId`.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la conexión.
   *
   * Cuerpo (`req.body`, objeto JSON):
   * - `sourceType` (obligatorio): tipo de fuente; uno de `BILLING_EXPORT`,
   *   `INVENTORY`, `TECHNICAL_METRIC`, `AGENT_METRIC`.
   * - `targetStart` (obligatorio): fecha ISO de inicio del rango.
   * - `targetEnd` (obligatorio): fecha ISO de fin del rango.
   *
   * Respuestas:
   * - 202: `{ success: true, job }` (trabajo de ingesta aceptado/encolado).
   * - 400 VALIDATION_ERROR: cuerpo no objeto, `id` ausente, `sourceType` no soportado o fechas inválidas.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 404 NOT_FOUND / 500: otros errores de dominio (ver {@link respondWithError}).
   */
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

  public queueTenantIngestion = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED');
      }

      const body = this.requireObjectBody(req.body);
      const job = await this.cloudConnectionService.queueIngestion({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        cloudConnectionId: this.requireString(body['cloudConnectionId'], 'cloudConnectionId'),
        sourceType: this.parseSourceType(body['sourceType']),
        targetStart: this.parseDate(body['targetStart'], 'targetStart'),
        targetEnd: this.parseDate(body['targetEnd'], 'targetEnd'),
      });

      res.status(202).json({ success: true, job });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public queueTechnicalBackfill = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED');
      }

      const body = this.requireObjectBody(req.body);
      const cloudConnectionId = this.requireString(body['cloudConnectionId'], 'cloudConnectionId');
      const lookbackDays = this.parseOptionalNumber(body['lookbackDays'], 'lookbackDays');
      const windowHours = this.parseOptionalNumber(body['windowHours'], 'windowHours');

      const backfill = await this.cloudConnectionService.queueTechnicalMetricBackfill({
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

  /**
   * Devuelve el estado de salud de la ingesta de una conexión.
   *
   * Sirve: GET /api/v1/cloud-connections/:id/ingestion-health
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la conexión.
   *
   * Respuestas:
   * - 200: `{ success: true, health }`.
   * - 400 VALIDATION_ERROR: `id` ausente.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 404 NOT_FOUND / 500: otros errores de dominio (ver {@link respondWithError}).
   */
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

  /**
   * Lista el historial de trabajos de ingesta del tenant autenticado (todas sus
   * conexiones), del más reciente al más antiguo.
   *
   * Sirve: GET /api/v1/ingestion/history
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de consulta (`req.query`):
   * - `limit` (opcional): máximo de resultados; el servicio lo acota a [1, 200].
   *
   * Respuestas:
   * - 200: `{ success: true, jobs }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado (ver {@link respondWithError}).
   */
  public listIngestionHistory = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const jobs = await this.cloudConnectionService.listIngestionHistory(
        tenantId,
        this.parseLimit(req.query['limit']),
      );

      res.status(200).json({ success: true, jobs });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  /**
   * Lista los controles de calidad de datos del tenant autenticado, del más
   * reciente al más antiguo.
   *
   * Sirve: GET /api/v1/ingestion/data-quality
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de consulta (`req.query`):
   * - `limit` (opcional): máximo de resultados; el servicio lo acota a [1, 200].
   *
   * Respuestas:
   * - 200: `{ success: true, checks }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado (ver {@link respondWithError}).
   */
  public listDataQuality = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const checks = await this.cloudConnectionService.listDataQualityChecks(
        tenantId,
        this.parseLimit(req.query['limit']),
      );

      res.status(200).json({ success: true, checks });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public getIngestionReadiness = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const readiness = await this.cloudConnectionService.getIngestionReadiness(tenantId);

      res.status(200).json({ success: true, readiness });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public configureFocusSource = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const body = this.requireObjectBody(req.body);
      const focusSource = await this.cloudConnectionService.configureFocusSource({
        tenantId,
        cloudConnectionId: this.requireString(body['cloudConnectionId'], 'cloudConnectionId'),
        mode: this.parseFocusSourceMode(body['mode']),
        values: this.requireStringRecord(body['values'], 'values'),
        replace: body['replace'] === true,
      });

      res.status(200).json({ success: true, focusSource });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  /**
   * Garantiza que la petición está autenticada y devuelve el `tenantId` del
   * contexto de autenticación. Lanza AUTHENTICATION_REQUIRED (mapeado a 401) si
   * `req.auth` no está presente.
   */
  private requireTenant(req: Request): string {
    if (req.auth === undefined) {
      throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED');
    }

    return req.auth.tenantId;
  }

  /**
   * Lee un parámetro de ruta obligatorio (`req.params[name]`) recortado.
   * Lanza VALIDATION_ERROR (mapeado a 400) si está ausente o vacío.
   */
  private requireParam(req: Request, name: string): string {
    const value = req.params[name];

    if (typeof value !== 'string' || value.trim() === '') {
      throw new FinOpsBaseError(`${name} is required`, 'VALIDATION_ERROR');
    }

    return value.trim();
  }

  /**
   * Valida que el cuerpo de la petición sea un objeto JSON (no nulo ni array).
   * Lanza VALIDATION_ERROR (mapeado a 400) en caso contrario.
   */
  private requireObjectBody(body: unknown): Record<string, unknown> {
    if (!this.isRecord(body)) {
      throw new FinOpsBaseError('Request body must be a JSON object', 'VALIDATION_ERROR');
    }

    return body;
  }

  /**
   * Valida que un campo sea una cadena no vacía y la devuelve recortada.
   * Lanza VALIDATION_ERROR (mapeado a 400) usando `fieldName` en el mensaje.
   */
  private requireString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new FinOpsBaseError(`${fieldName} is required`, 'VALIDATION_ERROR');
    }

    return value.trim();
  }

  /**
   * Convierte un campo en fecha a partir de una cadena ISO obligatoria.
   * Lanza VALIDATION_ERROR (mapeado a 400) si está ausente o no es una fecha válida.
   */
  private parseDate(value: unknown, fieldName: string): Date {
    const raw = this.requireString(value, fieldName);
    const parsed = new Date(raw);

    if (Number.isNaN(parsed.getTime())) {
      throw new FinOpsBaseError(`${fieldName} must be an ISO date`, 'VALIDATION_ERROR');
    }

    return parsed;
  }

  /**
   * Valida y normaliza el tipo de fuente de ingesta. Acepta únicamente
   * `BILLING_EXPORT`, `INVENTORY`, `TECHNICAL_METRIC` o `AGENT_METRIC`; en otro
   * caso lanza VALIDATION_ERROR (mapeado a 400).
   */
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

  private parseFocusSourceMode(value: unknown): 'location' | 'object' {
    const mode = this.requireString(value, 'mode');
    if (mode !== 'location' && mode !== 'object') {
      throw new FinOpsBaseError('mode must be location or object', 'VALIDATION_ERROR');
    }

    return mode;
  }

  private requireStringRecord(value: unknown, fieldName: string): Readonly<Record<string, string>> {
    if (!this.isRecord(value)) {
      throw new FinOpsBaseError(`${fieldName} must be an object`, 'VALIDATION_ERROR');
    }

    const entries = Object.entries(value);
    if (entries.length === 0) {
      throw new FinOpsBaseError(`${fieldName} must not be empty`, 'VALIDATION_ERROR');
    }

    return Object.fromEntries(entries.map(([key, item]) => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new FinOpsBaseError(`${fieldName}.${key} must be a non-empty string`, 'VALIDATION_ERROR');
      }

      return [key, item.trim()];
    }));
  }

  /**
   * Convierte el query param `limit` (string | string[] | undefined) a número,
   * o `undefined` si no viene o no es numérico. El acotado al rango válido lo
   * realiza el servicio ({@link CloudConnectionService.listIngestionHistory}).
   */
  private parseLimit(value: unknown): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;

    if (typeof raw !== 'string' || raw.trim() === '') {
      return undefined;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private parseOptionalNumber(
    value: unknown,
    fieldName: string,
  ): number | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) {
      throw new FinOpsBaseError(`${fieldName} must be a number`, 'VALIDATION_ERROR');
    }

    return parsed;
  }

  /**
   * Type guard que indica si un valor es un objeto plano (no nulo ni array).
   */
  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * Manejador centralizado de errores que traduce excepciones de dominio a
   * códigos de estado HTTP:
   * - {@link FinOpsBaseError} con código `NOT_FOUND` -> 404; `VALIDATION_ERROR`
   *   -> 400; `AUTHENTICATION_REQUIRED` -> 401; cualquier otro código -> 500.
   * - Error no controlado -> 500 con mensaje genérico de conexiones a la nube.
   */
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
