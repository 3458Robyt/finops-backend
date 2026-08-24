import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { E2eFixtureManifest } from '../../src/testing/e2eFixtures.js';

const baseUrl = process.env['API_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3000'}/api/v1`;

interface LoginResult {
  readonly accessToken: string;
  readonly activeTenantId: string;
  readonly availableTenantIds: readonly string[];
}

interface Credentials {
  readonly admin: { readonly email: string; readonly password: string };
  readonly viewer: { readonly email: string; readonly password: string };
}

const credentials = await readCredentials();
const adminLogin = await login(credentials.admin.email, credentials.admin.password);
const viewerLogin = await login(credentials.viewer.email, credentials.viewer.password);
const adminToken = adminLogin.accessToken;
const viewerToken = viewerLogin.accessToken;

const providers = await request('/cloud-connections/providers', adminToken, 200);
const connections = await request('/cloud-connections', adminToken, 200);
const connection = firstConnection(connections);
const accessibleTenants = await request('/auth/tenants', adminToken, 200);
const onboarding = await request(`/cloud-connections/${encodeURIComponent(connection.id)}/onboarding`, adminToken, 200);
const readiness = await request('/ingestion/readiness', adminToken, 200);
const operationalReads = [
    '/kpis/savings',
    '/costs',
    '/costs/options',
    '/technical-metrics/overview',
    '/technical-metrics/resources',
    '/budgets',
    '/cost-allocation/rules',
    '/cost-allocation/summary?period=2026-06',
    '/recommendations',
];
for (const path of operationalReads) await request(path, adminToken, 200);
for (const mutation of [
    { path: '/cloud-connections', method: 'POST' },
    { path: `/cloud-connections/${connection.id}`, method: 'PATCH' },
    { path: `/cloud-connections/${connection.id}/status`, method: 'PATCH' },
    { path: `/cloud-connections/${connection.id}/credentials`, method: 'POST' },
    { path: `/cloud-connections/${connection.id}/credentials/nonexistent`, method: 'DELETE' },
    { path: `/cloud-connections/${connection.id}/validate`, method: 'POST' },
    { path: `/cloud-connections/${connection.id}/focus-preview`, method: 'POST' },
    { path: `/cloud-connections/${connection.id}/activate`, method: 'POST' },
    { path: `/cloud-connections/${connection.id}/ingestion-jobs`, method: 'POST' },
    { path: `/cloud-connections/${connection.id}/ingestion-jobs/retry-failed`, method: 'POST' },
    { path: `/cloud-connections/${connection.id}/ingestion-jobs/cancel-pending`, method: 'POST' },
    { path: `/cloud-connections/${connection.id}/billing-source`, method: 'PUT' },
    { path: `/cloud-connections/${connection.id}/metric-definitions`, method: 'PUT' },
]) {
  await request(mutation.path, viewerToken, 403, { method: mutation.method, body: '{}' });
}
let crossTenantReadHidden = false;
const otherTenantId = adminLogin.availableTenantIds.find((tenantId) => tenantId !== connection.tenantId);
if (otherTenantId !== undefined) {
  const switched = await request('/auth/switch-tenant', adminToken, 200, {
    method: 'POST',
    body: JSON.stringify({ tenantId: otherTenantId }),
  });
  if (!isRecord(switched) || typeof switched['accessToken'] !== 'string') {
    throw new Error('Tenant switch did not return a usable access token.');
  }
  await request(`/cloud-connections/${encodeURIComponent(connection.id)}/onboarding`, switched['accessToken'], 404);
  crossTenantReadHidden = true;
}

const serialized = JSON.stringify(onboarding);
if (/encryptedPayload|encryptionIv|encryptionAuthTag|privateKey|passphrase|secretAccessKey|sessionToken/.test(serialized)) {
  throw new Error('El onboarding expuso material sensible.');
}
const issues = readArray(onboarding, 'onboarding', 'issues');
if (issues.some((issue) => !isRecord(issue) || typeof issue['action'] !== 'string' || !Array.isArray(issue['affectedData']))) {
  throw new Error('El readiness no entregó acciones estructuradas para sus problemas.');
}
console.log(JSON.stringify({
  success: true,
  providers: arrayLength(providers, 'providers'),
  connections: arrayLength(connections, 'connections'),
  accessibleTenants: arrayLength(accessibleTenants, 'availableTenants'),
  readinessConnections: arrayLength(readiness, 'readiness', 'connections'),
  safeOnboardingPayloadBytes: Buffer.byteLength(serialized),
  operationalReads: operationalReads.length,
  viewerMutationsDenied: 13,
  crossTenantReadHidden,
}, null, 2));

async function readCredentials(): Promise<Credentials> {
  const fixtureFile = resolve(process.env['E2E_FIXTURE_FILE'] ?? '.test-artifacts/e2e-fixtures.json');
  try {
    const manifest = JSON.parse(await readFile(fixtureFile, 'utf8')) as E2eFixtureManifest;
    return {
      admin: { email: manifest.admin.email, password: manifest.password },
      viewer: { email: manifest.viewer.email, password: manifest.password },
    };
  } catch (error: unknown) {
    if (!isFileMissing(error)) throw error;
  }

  return {
    admin: {
      email: requireEnv('SMOKE_ADMIN_EMAIL'),
      password: requireEnv('SMOKE_ADMIN_PASSWORD'),
    },
    viewer: {
      email: requireEnv('SMOKE_VIEWER_EMAIL'),
      password: requireEnv('SMOKE_VIEWER_PASSWORD'),
    },
  };
}

async function login(email: string, password: string): Promise<LoginResult> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof body['accessToken'] !== 'string') {
    throw new Error(`Login for smoke user failed with HTTP ${response.status}.`);
  }
  const activeTenant = isRecord(body['activeTenant']) ? body['activeTenant'] : undefined;
  if (activeTenant === undefined || typeof activeTenant['id'] !== 'string') {
    throw new Error('Login response did not include an active tenant.');
  }
  const availableTenants = readArray(body, 'availableTenants');
  return {
    accessToken: body['accessToken'],
    activeTenantId: activeTenant['id'],
    availableTenantIds: availableTenants.flatMap((tenant) => (
      isRecord(tenant) && typeof tenant['id'] === 'string' ? [tenant['id']] : []
    )),
  };
}

function firstConnection(value: unknown): { readonly id: string; readonly tenantId: string } {
  const first = readArray(value, 'connections')[0];
  if (!isRecord(first) || typeof first['id'] !== 'string' || typeof first['tenantId'] !== 'string') {
    throw new Error('The cloud connections endpoint did not return a usable connection.');
  }
  return { id: first['id'], tenantId: first['tenantId'] };
}

async function request(path: string, token: string, expectedStatus: number, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (response.status !== expectedStatus) {
    throw new Error(`${init.method ?? 'GET'} ${path}: esperado ${expectedStatus}, recibido ${response.status}`);
  }
  return response.json();
}

function arrayLength(value: unknown, ...path: readonly string[]): number {
  return readArray(value, ...path).length;
}

function readArray(value: unknown, ...path: readonly string[]): readonly unknown[] {
  let current = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  return Array.isArray(current) ? current : [];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required for the onboarding API smoke.`);
  return value;
}

function isFileMissing(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}
