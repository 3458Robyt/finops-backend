import { describe, expect, test, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { CloudConnectionService } from '../CloudConnectionService.js';
import type { ICloudConnectionRepository, StoreCloudCredentialInput } from '../../../domain/interfaces/ICloudConnectionRepository.js';
import type { CloudIngestionConnection, CloudIngestionProvider } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import type { CloudConnectionSummary } from '../../../domain/models/CloudConnection.js';

const connection: CloudConnectionSummary = {
  id: 'connection-1',
  tenantId: 'tenant-1',
  providerCode: 'oci',
  rootExternalId: 'ocid1.tenancy.oc1.test',
  name: 'OCI test',
  status: 'ACTIVE',
  defaultRegion: 'us-ashburn-1',
  createdAt: new Date('2026-08-16T00:00:00Z'),
  updatedAt: new Date('2026-08-16T00:00:00Z'),
};

const candidateConnection: CloudIngestionConnection = {
  id: connection.id,
  tenantId: connection.tenantId,
  providerCode: 'oci',
  rootExternalId: connection.rootExternalId,
  credentials: [{
    purpose: 'OPERATIONAL',
    payload: { tenancyId: connection.rootExternalId, userId: 'ocid1.user.oc1.test', privateKey: 'redacted' },
  }],
};

describe('CloudConnectionOnboarding staged credentials', () => {
  test('stores a candidate without blocking on provider validation', async () => {
    const repository = buildRepository();
    const provider = buildProvider({ status: 'VERIFIED' });
    const service = new CloudConnectionService(repository, [provider]);

    const result = await service.storeOperationalCredential({
      tenantId: 'tenant-1',
      cloudConnectionId: connection.id,
      purpose: 'OPERATIONAL',
      label: 'OCI candidate',
      payload: { tenancyId: connection.rootExternalId, userId: 'ocid1.user.oc1.test', privateKey: createPrivateKeyPem() },
    });

    expect(repository.stored?.initialStatus).toBe('PENDING');
    expect(repository.promoteCredential).not.toHaveBeenCalled();
    expect(repository.updateCredentialValidation).not.toHaveBeenCalled();
    expect(result.status).toBe('PENDING');
    expect(result.nextAction).toBe('VALIDATE');
  });

  test('promotes a candidate only after the separate validation operation verifies authentication', async () => {
    const repository = buildRepository();
    const provider = buildProvider({ status: 'VERIFIED' });
    const service = new CloudConnectionService(repository, [provider]);

    const stored = await service.storeOperationalCredential({
      tenantId: 'tenant-1',
      cloudConnectionId: connection.id,
      purpose: 'OPERATIONAL',
      label: 'OCI candidate',
      payload: { tenancyId: connection.rootExternalId, userId: 'ocid1.user.oc1.test', privateKey: createPrivateKeyPem() },
    });
    const result = await service.validateCredential({
      tenantId: 'tenant-1', cloudConnectionId: connection.id, credentialId: stored.id,
    });

    expect(repository.promoteCredential).toHaveBeenCalledWith('tenant-1', connection.id, 'credential-1');
    expect(result.credential.status).toBe('ACTIVE');
  });

  test('retains a rejected candidate as INVALID without disabling the active credential', async () => {
    const repository = buildRepository({
      credentialCreatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const provider = buildProvider({ status: 'REJECTED' });
    const service = new CloudConnectionService(repository, [provider]);

    const stored = await service.storeOperationalCredential({
      tenantId: 'tenant-1',
      cloudConnectionId: connection.id,
      purpose: 'OPERATIONAL',
      label: 'OCI invalid candidate',
      payload: { tenancyId: connection.rootExternalId, userId: 'ocid1.user.oc1.test', privateKey: createPrivateKeyPem() },
    });
    const result = await service.validateCredential({
      tenantId: 'tenant-1', cloudConnectionId: connection.id, credentialId: stored.id,
    });

    expect(repository.promoteCredential).not.toHaveBeenCalled();
    expect(repository.updateCredentialValidation).toHaveBeenCalledWith(
      'tenant-1', connection.id, 'credential-1', 'INVALID', 'REJECTED', expect.any(String), expect.any(Date),
    );
    expect(result.credential.status).toBe('INVALID');
  });

  test('keeps a fresh OCI key pending while provider registration can still propagate', async () => {
    const repository = buildRepository();
    const provider = buildProvider({ status: 'REJECTED' });
    const service = new CloudConnectionService(repository, [provider]);

    const stored = await service.storeOperationalCredential({
      tenantId: 'tenant-1',
      cloudConnectionId: connection.id,
      purpose: 'OPERATIONAL',
      label: 'OCI fresh candidate',
      payload: { tenancyId: connection.rootExternalId, userId: 'ocid1.user.oc1.test', privateKey: createPrivateKeyPem() },
    });
    const result = await service.validateCredential({
      tenantId: 'tenant-1', cloudConnectionId: connection.id, credentialId: stored.id,
    });

    expect(repository.updateCredentialValidation).toHaveBeenCalledWith(
      'tenant-1', connection.id, 'credential-1', 'PENDING', 'RETRYABLE_ERROR', expect.stringMatching(/propagando/i), expect.any(Date),
    );
    expect(result.credential).toMatchObject({ status: 'PENDING', validationStatus: 'RETRYABLE_ERROR' });
    expect(result.validation.authentication).toMatchObject({
      status: 'RETRYABLE_ERROR',
      metadata: { reasonCode: 'OCI_API_KEY_PROPAGATION_GRACE' },
    });
  });

  test('invokes repository lifecycle methods with their concrete receiver', async () => {
    const repository = buildBoundRepository();
    const service = new CloudConnectionService(repository, [buildProvider({ status: 'VERIFIED' })]);
    const stored = await service.storeOperationalCredential({
      tenantId: 'tenant-1',
      cloudConnectionId: connection.id,
      purpose: 'OPERATIONAL',
      label: 'OCI bound candidate',
      payload: { tenancyId: connection.rootExternalId, userId: 'ocid1.user.oc1.test', privateKey: createPrivateKeyPem() },
    });

    const result = await service.validateCredential({
      tenantId: 'tenant-1', cloudConnectionId: connection.id, credentialId: stored.id,
    });

    expect(result.credential.status).toBe('ACTIVE');
  });
});

function buildProvider(input: { readonly status: 'VERIFIED' | 'REJECTED' }): CloudIngestionProvider {
  return {
    providerCode: 'oci',
    validate: vi.fn(async () => ({
      providerCode: 'oci',
      authentication: {
        status: input.status,
        message: input.status === 'VERIFIED' ? 'Firma validada.' : 'Firma rechazada.',
        checkedAt: new Date(),
      },
      capabilities: [],
    })),
    collect: vi.fn(),
  } as unknown as CloudIngestionProvider;
}

function createPrivateKeyPem(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function buildRepository(options: { readonly credentialCreatedAt?: Date } = {}): ICloudConnectionRepository & {
  readonly stored?: StoreCloudCredentialInput;
  readonly promoteCredential: ReturnType<typeof vi.fn>;
  readonly updateCredentialValidation: ReturnType<typeof vi.fn>;
} {
  const credentialCreatedAt = options.credentialCreatedAt ?? new Date();
  const repository = {
    stored: undefined as StoreCloudCredentialInput | undefined,
    promoteCredential: vi.fn(async () => ({ id: 'credential-1', purpose: 'OPERATIONAL', status: 'ACTIVE', label: 'OCI candidate', createdAt: new Date() })),
    updateCredentialValidation: vi.fn(async (
      _tenantId: string,
      _connectionId: string,
      _credentialId: string,
      status: 'PENDING' | 'INVALID',
      validationStatus: 'VERIFIED' | 'REJECTED' | 'RETRYABLE_ERROR' | 'NOT_CONFIGURED',
      validationMessage: string,
    ) => ({
      id: 'credential-1', purpose: 'OPERATIONAL', status, label: 'OCI candidate',
      createdAt: credentialCreatedAt, validationStatus, validationMessage,
    })),
    findCloudConnectionForTenant: vi.fn(async () => connection),
    listCredentialSummaries: vi.fn(async () => [
      { id: 'credential-1', purpose: 'OPERATIONAL', status: 'PENDING', label: 'OCI candidate', createdAt: credentialCreatedAt },
    ]),
    storeCredential: vi.fn(async (input: StoreCloudCredentialInput) => {
      repository.stored = input;
      return { id: 'credential-1', purpose: input.purpose, status: 'PENDING', label: input.label, createdAt: credentialCreatedAt };
    }),
    getIngestionConnectionForCredential: vi.fn(async () => candidateConnection),
    saveConnectionValidation: vi.fn(async () => connection),
  };
  return repository as unknown as ICloudConnectionRepository & {
    readonly stored?: StoreCloudCredentialInput;
    readonly promoteCredential: ReturnType<typeof vi.fn>;
    readonly updateCredentialValidation: ReturnType<typeof vi.fn>;
  };
}

function buildBoundRepository(): ICloudConnectionRepository {
  const state = { status: 'PENDING' as 'PENDING' | 'ACTIVE' | 'INVALID' };
  const repository = buildRepository() as ICloudConnectionRepository & { readonly state: typeof state };
  Object.defineProperty(repository, 'state', { value: state });
  repository.getIngestionConnectionForCredential = async function () {
    if (this.state.status === 'INVALID') return null;
    return candidateConnection;
  };
  repository.promoteCredential = async function () {
    this.state.status = 'ACTIVE';
    return { id: 'credential-1', purpose: 'OPERATIONAL', status: 'ACTIVE', label: 'OCI candidate', createdAt: new Date() };
  };
  repository.updateCredentialValidation = async function (_tenantId, _connectionId, _credentialId, status) {
    this.state.status = status;
    return { id: 'credential-1', purpose: 'OPERATIONAL', status, label: 'OCI candidate', createdAt: new Date() };
  };
  return repository;
}
