import type { ProviderCatalogEntry } from '../models/CloudConnection.js';

export interface TemporaryAdminProvisioningInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly temporaryAdminCredential: Readonly<Record<string, unknown>>;
}

export interface TemporaryAdminProvisioningResult {
  readonly operationalPrincipalId: string;
  readonly exportExternalId?: string;
  readonly exportPath?: string;
  readonly storageLocationRef?: string;
  readonly messages: readonly string[];
}

export interface CloudProviderPlugin {
  readonly catalog: ProviderCatalogEntry;
  provisionWithTemporaryAdmin(
    input: TemporaryAdminProvisioningInput,
  ): Promise<TemporaryAdminProvisioningResult>;
  validateOperationalAccess(cloudConnectionId: string): Promise<readonly string[]>;
}
