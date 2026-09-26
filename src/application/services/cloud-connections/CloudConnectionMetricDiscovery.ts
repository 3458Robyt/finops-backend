import type { ICloudConnectionRepository } from '../../../domain/interfaces/ICloudConnectionRepository.js';
import type { IResourceMetricRepository } from '../../../domain/interfaces/IResourceMetricRepository.js';
import type {
  CloudIngestionProvider,
  CloudMetricDiscoveryResult,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import { withTimeout } from '../cloudConnectionPolicies.js';
import { requireNonEmpty } from './CloudConnectionInputPolicy.js';
import type { PreviewMetricDefinitionsInput } from './CloudConnectionContracts.js';

export type MetricDiscoveryInventoryReader = Pick<IResourceMetricRepository, 'listResourcesForTenantByIdentities'>;

export class CloudConnectionMetricDiscovery {
  private readonly providers: ReadonlyMap<string, CloudIngestionProvider>;

  constructor(
    private readonly repository: ICloudConnectionRepository,
    providers: readonly CloudIngestionProvider[],
    private readonly inventoryReader?: MetricDiscoveryInventoryReader,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.providerCode, provider]));
  }

  public async preview(input: PreviewMetricDefinitionsInput): Promise<CloudMetricDiscoveryResult> {
    input.signal?.throwIfAborted();
    const connection = await this.repository.getIngestionConnectionForTenant(input.tenantId, input.cloudConnectionId);
    input.signal?.throwIfAborted();
    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe, está deshabilitada o no pertenece al tenant activo.', 'NOT_FOUND');
    }
    const provider = this.providers.get(connection.providerCode);
    if (provider?.discoverMetricDefinitions === undefined) {
      throw new FinOpsBaseError('Este proveedor no soporta el descubrimiento de métricas.', 'PROVIDER_NOT_ENABLED');
    }
    const scope = normalizeScope(input.scope);
    const controller = new AbortController();
    const abortProvider = () => controller.abort();
    input.signal?.addEventListener('abort', abortProvider, { once: true });
    let result: CloudMetricDiscoveryResult;
    try {
      input.signal?.throwIfAborted();
      result = await withTimeout(
        provider.discoverMetricDefinitions(connection, scope, controller.signal),
        20_000,
        'El descubrimiento de métricas superó el tiempo máximo de 20 segundos.',
      );
      input.signal?.throwIfAborted();
      const inventoryLinkageById = await this.findInventoryLinkage(input.tenantId, input.cloudConnectionId, result.definitions);
      input.signal?.throwIfAborted();
      const discovery: CloudMetricDiscoveryResult = {
        ...result,
        definitions: result.definitions.map((definition) => {
          const resourceId = definition.resourceId.trim();
          const match = inventoryLinkageById?.get(resourceId);
          const inventoryLinkage = resourceId === ''
            ? { status: 'MISSING_RESOURCE_ID' as const }
            : inventoryLinkageById === null
              ? { status: 'NOT_VERIFIED' as const }
              : match === undefined
                ? { status: 'NOT_FOUND' as const }
                : { status: 'MATCHED' as const, ...(match.name === undefined ? {} : { resourceName: match.name }) };
          return { ...definition, inventoryLinkage };
        }),
      };
      await this.repository.createCloudAuditEvent({
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'CLOUD_METRIC_DISCOVERY_PREVIEWED',
        entityType: 'CLOUD_CONNECTION',
        entityId: input.cloudConnectionId,
        metadata: {
          regionId: scope.regionId,
          definitions: discovery.definitions.length,
          apiCallCount: result.apiCallCount,
          truncated: result.truncated,
        },
      });
      return discovery;
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      input.signal?.removeEventListener('abort', abortProvider);
    }
  }

  private async findInventoryLinkage(
    tenantId: string,
    cloudConnectionId: string,
    definitions: CloudMetricDiscoveryResult['definitions'],
  ): Promise<Map<string, { readonly name?: string }> | null> {
    const listByIdentities = this.inventoryReader?.listResourcesForTenantByIdentities;
    if (listByIdentities === undefined) return null;
    const identities = [...new Set(definitions.map((item) => item.resourceId.trim()).filter(Boolean))]
      .map((externalResourceId) => ({ cloudConnectionId, externalResourceId }));
    if (identities.length === 0) return new Map();
    const resources = await listByIdentities.call(this.inventoryReader, tenantId, identities);
    return new Map(resources.map((resource) => [resource.externalResourceId, { ...(resource.name === undefined ? {} : { name: resource.name }) }]));
  }
}

function normalizeScope(scope: PreviewMetricDefinitionsInput['scope']): PreviewMetricDefinitionsInput['scope'] {
  const regionId = requireNonEmpty(scope.regionId, 'regionId');
  const compartmentId = requireNonEmpty(scope.compartmentId, 'compartmentId');
  const namespace = scope.namespace === undefined ? undefined : requireNonEmpty(scope.namespace, 'namespace');
  if (!/^[a-z0-9-]{2,50}$/i.test(regionId)) {
    throw new FinOpsBaseError('La región debe contener solo letras, números y guiones.', 'VALIDATION_ERROR');
  }
  if (compartmentId.length > 512 || /[\u0000-\u001f]/.test(compartmentId)) {
    throw new FinOpsBaseError('El compartment no tiene un formato válido.', 'VALIDATION_ERROR');
  }
  if (namespace !== undefined && (namespace.length > 128 || /[\u0000-\u001f]/.test(namespace))) {
    throw new FinOpsBaseError('El namespace no tiene un formato válido.', 'VALIDATION_ERROR');
  }
  return { regionId, compartmentId, ...(namespace === undefined ? {} : { namespace }) };
}
