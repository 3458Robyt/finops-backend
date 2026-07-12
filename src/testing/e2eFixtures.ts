import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  CloudProvider,
  Prisma,
  PrismaClient,
} from '../generated/prisma/client.js';

export interface E2eFixtureManifest {
  readonly runId: string;
  readonly createdAt: string;
  readonly password: string;
  readonly admin: {
    readonly email: string;
    readonly name: string;
  };
  readonly tenants: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  }[];
  readonly recommendationIds: readonly string[];
  readonly resourceIds: readonly string[];
}

const fixturePrefix = 'e2e-finops';

export function createTestingPrismaClient(): PrismaClient {
  const connectionString = process.env['TEST_DATABASE_URL'];
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('TEST_DATABASE_URL is required for integration/E2E fixtures.');
  }

  if (process.env['ALLOW_DESTRUCTIVE_TEST_DATABASE'] !== 'true') {
    throw new Error('ALLOW_DESTRUCTIVE_TEST_DATABASE=true is required for integration/E2E fixtures.');
  }

  const runtimeDatabaseUrl = process.env['DATABASE_URL'];
  if (runtimeDatabaseUrl !== undefined && runtimeDatabaseUrl === connectionString) {
    throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL.');
  }

  const databaseName = new URL(connectionString).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must point to a database ending in _test.');
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
}

export function resolveFixtureFile(): string {
  return resolve(process.env['E2E_FIXTURE_FILE'] ?? '.test-artifacts/e2e-fixtures.json');
}

export function generateRunId(): string {
  return process.env['E2E_RUN_ID'] ?? `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function writeFixtureManifest(manifest: E2eFixtureManifest, filePath = resolveFixtureFile()): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function cleanupE2eFixtures(prisma: PrismaClient, runId?: string): Promise<number> {
  const slugPrefix = runId === undefined ? `${fixturePrefix}-` : `${fixturePrefix}-${runId}`;
  const tenants = await prisma.tenant.findMany({
    where: {
      slug: {
        startsWith: slugPrefix,
      },
    },
    select: {
      id: true,
    },
  });

  if (tenants.length === 0) {
    return 0;
  }

  const tenantIds = tenants.map((tenant) => tenant.id);
  const users = await prisma.user.findMany({
    where: {
      tenantId: {
        in: tenantIds,
      },
    },
    select: {
      id: true,
    },
  });
  const userIds = users.map((user) => user.id);
  const recommendations = await prisma.recommendation.findMany({
    where: {
      tenantId: {
        in: tenantIds,
      },
    },
    select: {
      id: true,
    },
  });
  const recommendationIds = recommendations.map((recommendation) => recommendation.id);

  await prisma.$transaction([
    prisma.agentLearningEvent.deleteMany({
      where: {
        tenantId: {
          in: tenantIds,
        },
      },
    }),
    prisma.recommendationManualExecution.deleteMany({
      where: {
        OR: [
          { tenantId: { in: tenantIds } },
          { userId: { in: userIds } },
          { recommendationId: { in: recommendationIds } },
        ],
      },
    }),
    prisma.recommendationDecision.deleteMany({
      where: {
        OR: [
          { userId: { in: userIds } },
          { recommendationId: { in: recommendationIds } },
        ],
      },
    }),
    prisma.recommendationExecutionPlan.deleteMany({
      where: {
        OR: [
          { generatedByUserId: { in: userIds } },
          { recommendationId: { in: recommendationIds } },
        ],
      },
    }),
  ]);

  await prisma.tenant.deleteMany({
    where: {
      id: {
        in: tenantIds,
      },
    },
  });

  return tenantIds.length;
}

export async function createE2eFixtures(prisma: PrismaClient, runId = generateRunId()): Promise<E2eFixtureManifest> {
  await cleanupE2eFixtures(prisma, runId);
  await ensureProviderCatalog(prisma);

  const password = process.env['E2E_PASSWORD'] ?? `FinOps-${runId}-Test!`;
  const passwordHash = await argon2.hash(password);
  const tenantA = await prisma.tenant.create({
    data: {
      name: `E2E Tenant A ${runId}`,
      slug: `${fixturePrefix}-${runId}-a`,
      status: 'ACTIVE',
    },
  });
  const tenantB = await prisma.tenant.create({
    data: {
      name: `E2E Tenant B ${runId}`,
      slug: `${fixturePrefix}-${runId}-b`,
      status: 'ACTIVE',
    },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: tenantA.id,
      email: `${fixturePrefix}-${runId}@example.test`,
      name: `E2E Admin ${runId}`,
      passwordHash,
      role: 'MASTER_ADMIN',
      status: 'ACTIVE',
    },
  });

  const tenantAFixture = await seedTenantData(prisma, {
    runId,
    tenantId: tenantA.id,
    userId: user.id,
    provider: 'AWS',
    providerCode: 'aws',
    accountId: `${runId}-aws-prod`,
    resourceId: `i-${runId.slice(0, 8)}`,
    resourceName: `e2e-ec2-${runId}`,
    serviceName: 'Amazon Elastic Compute Cloud',
  });

  await seedTenantData(prisma, {
    runId,
    tenantId: tenantB.id,
    userId: user.id,
    provider: 'OCI',
    providerCode: 'oci',
    accountId: `${runId}-oci-prod`,
    resourceId: `ocid1.instance.oc1.iad.${runId}`,
    resourceName: `e2e-oci-${runId}`,
    serviceName: 'Oracle Compute',
  });

  return {
    runId,
    createdAt: new Date().toISOString(),
    password,
    admin: {
      email: user.email,
      name: user.name,
    },
    tenants: [
      { id: tenantA.id, name: tenantA.name, slug: tenantA.slug },
      { id: tenantB.id, name: tenantB.name, slug: tenantB.slug },
    ],
    recommendationIds: [tenantAFixture.recommendationId],
    resourceIds: [tenantAFixture.resourceId],
  };
}

async function ensureProviderCatalog(prisma: PrismaClient): Promise<void> {
  await prisma.providerCatalog.upsert({
    where: { code: 'aws' },
    update: {
      displayName: 'Amazon Web Services',
      provider: 'AWS',
      enabled: true,
    },
    create: {
      code: 'aws',
      displayName: 'Amazon Web Services',
      provider: 'AWS',
      enabled: true,
    },
  });
  await prisma.providerCatalog.upsert({
    where: { code: 'oci' },
    update: {
      displayName: 'Oracle Cloud Infrastructure',
      provider: 'OCI',
      enabled: true,
    },
    create: {
      code: 'oci',
      displayName: 'Oracle Cloud Infrastructure',
      provider: 'OCI',
      enabled: true,
    },
  });
}

async function seedTenantData(
  prisma: PrismaClient,
  input: {
    readonly runId: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly provider: CloudProvider;
    readonly providerCode: string;
    readonly accountId: string;
    readonly resourceId: string;
    readonly resourceName: string;
    readonly serviceName: string;
  },
): Promise<{ readonly recommendationId: string; readonly resourceId: string }> {
  const now = new Date();
  const periodStart = new Date(Date.UTC(2026, 4, 1));
  const connection = await prisma.cloudConnection.create({
    data: {
      tenantId: input.tenantId,
      providerCode: input.providerCode,
      rootExternalId: input.accountId,
      name: `E2E ${input.provider} ${input.runId}`,
      status: 'ACTIVE',
      defaultRegion: input.provider === 'AWS' ? 'us-east-1' : 'us-ashburn-1',
      metadata: { e2eRunId: input.runId },
    },
  });
  const account = await prisma.cloudAccount.create({
    data: {
      tenantId: input.tenantId,
      provider: input.provider,
      externalAccountId: input.accountId,
      name: `E2E Account ${input.runId}`,
      defaultRegion: input.provider === 'AWS' ? 'us-east-1' : 'us-ashburn-1',
      status: 'ACTIVE',
    },
  });
  const resource = await prisma.cloudResource.create({
    data: {
      tenantId: input.tenantId,
      cloudConnectionId: connection.id,
      provider: input.provider,
      externalResourceId: input.resourceId,
      name: input.resourceName,
      resourceType: 'COMPUTE_INSTANCE',
      serviceName: input.serviceName,
      regionId: input.provider === 'AWS' ? 'us-east-1' : 'us-ashburn-1',
      status: 'ACTIVE',
      tags: { environment: 'e2e', runId: input.runId },
      rawResource: { source: 'e2e-fixture' },
      firstSeenAt: periodStart,
      lastSeenAt: now,
    },
  });

  await prisma.costMetric.createMany({
    data: buildCostMetrics(input, account.id, periodStart),
  });
  await prisma.costForecast.create({
    data: {
      tenantId: input.tenantId,
      cloudAccountId: account.id,
      provider: input.provider,
      serviceName: input.serviceName,
      groupBy: 'service',
      groupKey: input.serviceName,
      forecastMonth: periodStart,
      predictedCost: new Prisma.Decimal(180),
      lowerBound: new Prisma.Decimal(160),
      upperBound: new Prisma.Decimal(200),
      method: 'e2e-fixture',
      confidence: new Prisma.Decimal(0.8),
      currency: 'USD',
      evidence: { e2eRunId: input.runId },
    },
  });
  await prisma.resourceMetricSample.createMany({
    data: buildMetricSamples(input, connection.id, resource.id, periodStart),
  });

  const recommendation = await prisma.recommendation.create({
    data: {
      tenantId: input.tenantId,
      cloudAccountId: account.id,
      type: 'RIGHTSIZING',
      status: 'PENDING',
      severity: 'HIGH',
      title: `Reducir capacidad de ${input.resourceName}`,
      description: 'La instancia muestra baja utilizacion de CPU y costo sostenido. Validar ventana de carga antes de aplicar rightsizing.',
      estimatedMonthlySavings: new Prisma.Decimal(42.25),
      currency: 'USD',
      evidence: {
        e2eRunId: input.runId,
        evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
        cloudResourceId: resource.id,
        externalResourceId: input.resourceId,
        technicalEvidenceRefs: [`resource_metric_samples:${input.resourceId}:CPUUtilization:2026-05`],
        technicalSampleCount: 96,
        technicalCoverageDays: 2,
        latestTechnicalSampleAt: new Date(Date.UTC(2026, 4, 2, 23, 30)).toISOString(),
        recommendationEvidenceSnapshot: {
          version: '1',
          hash: `e2e-evidence-${input.runId}`,
          tenantId: input.tenantId,
          periodStart: periodStart.toISOString(),
          periodEnd: now.toISOString(),
          generatedAt: now.toISOString(),
          availability: 'COST_USAGE_AND_TECHNICAL_AVAILABLE',
          resources: [{
            externalResourceId: input.resourceId,
            cloudResourceId: resource.id,
            provider: input.provider,
            linkQuality: 'COST_AND_TECHNICAL',
            cost: { totalCost: 169, currency: 'USD', focusMetricCount: 31 },
            usage: [],
            metrics: [{
              metricName: 'CPUUtilization', metricUnit: 'Percent', sampleCount: 96, coverageDays: 2,
              min: 2, max: 20, avg: 8, p50: 8, p95: 15, p99: 20, latest: 8,
              firstSampledAt: periodStart.toISOString(), latestSampledAt: new Date(Date.UTC(2026, 4, 2, 23, 30)).toISOString(),
              evidenceRef: `resource_metric_samples:${input.resourceId}:CPUUtilization:2026-05`,
            }],
            ruleEvaluation: {
              externalResourceId: input.resourceId, cloudResourceId: resource.id, provider: input.provider,
              readiness: 'VALIDATION_ONLY', evidenceStrength: 'MEDIUM', recommendedActionType: 'TECHNICAL_VALIDATION_REQUIRED',
              ruleMatches: ['CPU_STRONG_UNDERUTILIZATION'], blockers: ['INSUFFICIENT_TECHNICAL_COVERAGE'],
              sourceFacts: ['Fixture con cobertura limitada para exigir validación técnica.'],
              technicalEvidenceRefs: [`resource_metric_samples:${input.resourceId}:CPUUtilization:2026-05`],
              metricSummary: [], maxTechnicalSavingsRate: 0,
            },
          }],
          deterministicRules: [],
        },
        aiAudit: { verdict: 'APPROVED', score: 94, checks: [], blockingIssues: [], requiredChanges: [] },
        aiLearning: { memoryIds: ['e2e-memory-1'], caseIds: ['e2e-case-1'], summary: 'Fixture de aprendizaje auditado.' },
      },
    },
  });

  await prisma.recommendationExecutionPlan.create({
    data: {
      recommendationId: recommendation.id,
      generatedByUserId: input.userId,
      model: 'fixture-model',
      auditorModel: 'fixture-auditor',
      content: {
        summary: 'Validar baja utilizacion y reducir capacidad en una ventana controlada.',
        scope: {
          cloudAccountId: account.id,
          externalResourceId: input.resourceId,
          service: input.serviceName,
        },
        prerequisites: ['Confirmar propietario del servicio.', 'Revisar metricas de CPU y memoria.'],
        steps: ['Crear respaldo/configuracion actual.', 'Aplicar cambio de capacidad.', 'Monitorear 24 horas.'],
        validation: ['Comparar CPU, memoria, errores y costo diario.'],
        risks: ['Degradacion si el patron de carga cambia.'],
        rollback: ['Restaurar el shape/tamano previo.'],
        successCriteria: ['Reducir costo mensual sin degradacion del servicio.'],
        estimatedSavings: { amount: 42.25, currency: 'USD' },
      },
      auditReport: {
        verdict: 'APPROVED',
        score: 92,
        checks: [{ name: 'evidencia_tecnica', passed: true, notes: 'Incluye metricas y rollback.' }],
        blockingIssues: [],
        requiredChanges: [],
      },
      auditVerdict: 'APPROVED',
      auditScore: 92,
    },
  });

  await prisma.aiContextTrace.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      operation: 'RECOMMENDATION',
      model: 'fixture-model',
      status: 'SUCCESS',
      promptTokenEstimate: 250,
      responseTokenEstimate: 120,
      latencyMs: 80,
      artifactIds: [recommendation.id],
      expiresAt: new Date(Date.UTC(2027, 4, 1)),
    },
  });

  return { recommendationId: recommendation.id, resourceId: resource.id };
}

function buildCostMetrics(
  input: {
    readonly runId: string;
    readonly tenantId: string;
    readonly provider: CloudProvider;
    readonly accountId: string;
    readonly resourceId: string;
    readonly resourceName: string;
    readonly serviceName: string;
  },
  cloudAccountId: string,
  periodStart: Date,
): Prisma.CostMetricCreateManyInput[] {
  return Array.from({ length: 14 }, (_, index) => {
    const start = new Date(periodStart);
    start.setUTCDate(start.getUTCDate() + index);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    return {
      tenantId: input.tenantId,
      cloudAccountId,
      provider: input.provider,
      serviceName: input.serviceName,
      resourceId: input.resourceId,
      resourceName: input.resourceName,
      resourceType: 'COMPUTE_INSTANCE',
      regionId: input.provider === 'AWS' ? 'us-east-1' : 'us-ashburn-1',
      chargePeriodStart: start,
      chargePeriodEnd: end,
      billingPeriodStart: periodStart,
      billingPeriodEnd: new Date(Date.UTC(2026, 5, 1)),
      billedCost: new Prisma.Decimal(8 + index * 0.5),
      effectiveCost: new Prisma.Decimal(8 + index * 0.5),
      billingCurrency: 'USD',
      pricingCurrency: 'USD',
      consumedQuantity: new Prisma.Decimal(24),
      consumedUnit: 'Hours',
      pricingQuantity: new Prisma.Decimal(24),
      pricingUnit: 'Hours',
      sourceMetric: 'E2E',
      metricIdentityHash: `${input.runId}:${input.accountId}:${input.resourceId}:cost:${index}`,
      tags: { e2eRunId: input.runId },
      providerRaw: { fixture: true },
    };
  });
}

function buildMetricSamples(
  input: {
    readonly runId: string;
    readonly tenantId: string;
    readonly provider: CloudProvider;
    readonly resourceId: string;
  },
  cloudConnectionId: string,
  cloudResourceId: string,
  periodStart: Date,
): Prisma.ResourceMetricSampleCreateManyInput[] {
  const metricNames = [
    { name: 'CPUUtilization', unit: '%' },
    { name: 'MemoryUtilization', unit: '%' },
    { name: 'NetworkIn', unit: 'Bytes' },
  ] as const;

  return metricNames.flatMap((metric, metricIndex) => Array.from({ length: 96 }, (_, index) => {
    const sampledAt = new Date(periodStart);
    sampledAt.setUTCMinutes(sampledAt.getUTCMinutes() + index * 30);
    const base = metric.name === 'CPUUtilization' ? 8 : metric.name === 'MemoryUtilization' ? 48 : 1024;
    const value = base + (index % 12) + metricIndex;

    return {
      tenantId: input.tenantId,
      cloudConnectionId,
      cloudResourceId,
      provider: input.provider,
      externalResourceId: input.resourceId,
      metricName: metric.name,
      metricUnit: metric.unit,
      value: new Prisma.Decimal(value),
      sampledAt,
      granularitySeconds: 1800,
      sourceType: 'TECHNICAL_METRIC',
      rawMetric: { e2eRunId: input.runId, fixture: true },
    };
  }));
}
