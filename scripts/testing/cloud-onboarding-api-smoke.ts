import 'dotenv/config';
import { getPrismaClient } from '../../src/infrastructure/database/prisma.js';
import { JwtTokenService } from '../../src/infrastructure/security/JwtTokenService.js';

const prisma = getPrismaClient();
const baseUrl = process.env['API_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3000'}/api/v1`;

try {
  const [admin, viewer, connection] = await Promise.all([
    prisma.user.findFirstOrThrow({ where: { role: 'MASTER_ADMIN', status: 'ACTIVE' } }),
    prisma.user.findFirstOrThrow({ where: { role: 'VIEWER', status: 'ACTIVE' } }),
    prisma.cloudConnection.findFirstOrThrow({ where: { status: 'ACTIVE', providerCode: { in: ['aws', 'oci'] } } }),
  ]);
  const tokens = new JwtTokenService();
  const adminToken = tokens.issueToken({ userId: admin.id, tenantId: connection.tenantId, email: admin.email, role: admin.role }).token;
  const viewerToken = tokens.issueToken({ userId: viewer.id, tenantId: viewer.tenantId, email: viewer.email, role: viewer.role }).token;

  const providers = await request('/cloud-connections/providers', adminToken, 200);
  const connections = await request('/cloud-connections', adminToken, 200);
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
  if (viewer.tenantId !== connection.tenantId) {
    await request(`/cloud-connections/${encodeURIComponent(connection.id)}/onboarding`, viewerToken, 404);
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
    crossTenantReadHidden: viewer.tenantId !== connection.tenantId,
  }, null, 2));
} finally {
  await prisma.$disconnect();
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
