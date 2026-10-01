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
import type { TechnicalMetricSummaryItem } from '../domain/interfaces/IResourceMetricRepository.js';
import { evaluateTechnicalOptimizationRules } from '../application/services/ai/TechnicalOptimizationRuleEngine.js';
import { buildPostgresSessionOptions } from '../infrastructure/database/tenantContext.js';

export interface E2eFixtureManifest {
  readonly runId: string;
  readonly createdAt: string;
  readonly password: string;
  readonly admin: {
    readonly email: string;
    readonly name: string;
  };
  readonly viewer: {
    readonly email: string;
    readonly name: string;
  };
  readonly technician: {
    readonly email: string;
    readonly name: string;
  };
  readonly operatorAdmin: {
    readonly email: string;
    readonly name: string;
  };
  readonly leadTechnician: {
    readonly email: string;
    readonly name: string;
  };
  readonly clientApprover: {
    readonly email: string;
    readonly name: string;
  };
  readonly clientViewer: {
    readonly email: string;
    readonly name: string;
  };
  readonly tenants: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  }[];
  readonly billingPeriod: string;
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

  const parsedUrl = new URL(connectionString);
  const databaseName = parsedUrl.pathname.replace(/^\//, '');
  const schema = parsedUrl.searchParams.get('schema') ?? undefined;
  const isolatedSchema = schema !== undefined && /^finops_e2e_[a-z0-9_]+$/.test(schema);
  if (!databaseName.endsWith('_test') && !isolatedSchema) {
    throw new Error('TEST_DATABASE_URL must point to a database ending in _test or an isolated finops_e2e_* schema.');
  }

  return new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString,
        options: buildPostgresSessionOptions(schema),
      },
      schema === undefined ? undefined : { schema },
    ),
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
  const periodStart = recentFixturePeriodStart(new Date());

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
  const viewer = await prisma.user.create({
    data: {
      tenantId: tenantA.id,
      email: `${fixturePrefix}-viewer-${runId}@example.test`,
      name: `E2E Viewer ${runId}`,
      passwordHash,
      role: 'VIEWER',
      status: 'ACTIVE',
    },
  });
  const technician = await prisma.user.create({
    data: {
      tenantId: tenantA.id,
      email: `${fixturePrefix}-technician-${runId}@example.test`,
      name: `E2E Technician ${runId}`,
      passwordHash,
      role: 'FINOPS_TECHNICIAN',
      status: 'ACTIVE',
    },
  });
  const operatorAdmin = await prisma.user.create({
    data: {
      tenantId: tenantA.id,
      email: `${fixturePrefix}-operator-${runId}@example.test`,
      name: `E2E Operator Admin ${runId}`,
      passwordHash,
      role: 'OPERATOR_ADMIN',
      status: 'ACTIVE',
    },
  });
  const leadTechnician = await prisma.user.create({
    data: {
      tenantId: tenantA.id,
      email: `${fixturePrefix}-lead-${runId}@example.test`,
      name: `E2E Lead Technician ${runId}`,
      passwordHash,
      role: 'LEAD_TECHNICIAN',
      status: 'ACTIVE',
    },
  });
  const clientApprover = await prisma.user.create({
    data: {
      tenantId: tenantB.id,
      email: `${fixturePrefix}-approver-${runId}@example.test`,
      name: `E2E Client Approver ${runId}`,
      passwordHash,
      role: 'CLIENT_APPROVER',
      status: 'ACTIVE',
    },
  });
  const clientViewer = await prisma.user.create({
    data: {
      tenantId: tenantB.id,
      email: `${fixturePrefix}-client-viewer-${runId}@example.test`,
      name: `E2E Client Viewer ${runId}`,
      passwordHash,
      role: 'CLIENT_VIEWER',
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
    periodStart,
  });

  const tenantAConnection = await prisma.cloudConnection.findFirst({
    where: { tenantId: tenantA.id },
    select: { id: true },
  });
  if (tenantAConnection === null) throw new Error('E2E fixture connection was not created.');
  await prisma.ingestionJob.create({
    data: {
      tenantId: tenantA.id,
      cloudConnectionId: tenantAConnection.id,
      sourceType: 'BILLING_EXPORT',
      status: 'FAILED',
      dataOutcome: 'PROVIDER_ERROR',
      requestedByUserId: user.id,
      targetStart: periodStart,
      targetEnd: new Date(periodStart.getTime() + 60 * 60 * 1000),
      attempts: 3,
      maxAttempts: 3,
      priority: 50,
      errorMessage: 'Fixture provider error for audited reprocessing.',
      requestContext: { e2eRunId: runId, fixture: true },
      progress: { phase: 'FAILED', message: 'Fixture job available for reprocessing tests.' },
      completedAt: new Date(),
    },
  });
  await prisma.ingestionJob.create({
    data: {
      tenantId: tenantA.id,
      cloudConnectionId: tenantAConnection.id,
      sourceType: 'BILLING_EXPORT',
      status: 'SUCCESS',
      dataOutcome: 'PARTIAL',
      requestedByUserId: user.id,
      targetStart: new Date(periodStart.getTime() - 60 * 60 * 1000),
      targetEnd: periodStart,
      attempts: 1,
      maxAttempts: 3,
      priority: 50,
      requestContext: { e2eRunId: runId, fixture: true, focusSchemaCase: 'nonconformant' },
      progress: { phase: 'COMPLETED', message: 'Fixture con esquema FOCUS incompleto.' },
      resultSummary: {
        focusRows: 4,
        focusRowsInserted: 4,
        warnings: ['Fixture: FOCUS 1.0 sin dos columnas obligatorias.'],
        coverage: {
          focusSchemaValidation: {
            status: 'NONCONFORMANT',
            filesChecked: 2,
            filesConformant: 0,
            filesNonconformant: 2,
            filesUnverified: 0,
            missingMandatoryColumns: ['ChargeClass', 'ContractedCost'],
          },
        },
      },
      completedAt: new Date(),
    },
  });
  await prisma.ingestionJob.create({
    data: {
      tenantId: tenantA.id,
      cloudConnectionId: tenantAConnection.id,
      sourceType: 'TECHNICAL_METRIC',
      status: 'PENDING',
      requestedByUserId: user.id,
      targetStart: new Date(periodStart.getTime() + 60 * 60 * 1000),
      targetEnd: new Date(periodStart.getTime() + 2 * 60 * 60 * 1000),
      attempts: 0,
      maxAttempts: 3,
      priority: 25,
      requestContext: { e2eRunId: runId, fixture: true, readinessCase: 'pending_without_worker' },
      progress: { phase: 'QUEUED', message: 'Fixture pendiente para validar readiness sin worker.' },
    },
  });

  await seedTenantData(prisma, {
    runId,
    tenantId: tenantB.id,
    userId: user.id,
    provider: 'OCI',
    providerCode: 'oci',
    accountId: `${runId}-oci-prod`,
    resourceId: `ocid1.instance.oc1..exampleid0014.${runId}`,
    resourceName: `e2e-oci-${runId}`,
    serviceName: 'Oracle Compute',
    periodStart,
  });

  return {
    runId,
    createdAt: new Date().toISOString(),
    password,
    admin: {
      email: user.email,
      name: user.name,
    },
    viewer: {
      email: viewer.email,
      name: viewer.name,
    },
    technician: { email: technician.email, name: technician.name },
    operatorAdmin: { email: operatorAdmin.email, name: operatorAdmin.name },
    leadTechnician: { email: leadTechnician.email, name: leadTechnician.name },
    clientApprover: { email: clientApprover.email, name: clientApprover.name },
    clientViewer: { email: clientViewer.email, name: clientViewer.name },
    tenants: [
      { id: tenantA.id, name: tenantA.name, slug: tenantA.slug },
      { id: tenantB.id, name: tenantB.name, slug: tenantB.slug },
    ],
    billingPeriod: periodStart.toISOString().slice(0, 7),
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
    readonly periodStart: Date;
  },
): Promise<{ readonly recommendationId: string; readonly resourceId: string }> {
  const now = new Date();
  const { periodStart } = input;
  const technicalPeriodStart = new Date(now.getTime() - 14 * 86400000);
  const latestTechnicalSampleAt = new Date(now.getTime() - 1800000);
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
    data: buildCostMetrics(input, account.id, connection.id, resource.id, periodStart),
  });
  await prisma.costForecast.create({
    data: {
      tenantId: input.tenantId,
      cloudAccountId: account.id,
      provider: input.provider,
      serviceName: input.serviceName,
      groupBy: 'service',
      groupKey: input.serviceName,
      forecastMonth: new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), 1)),
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
    data: buildMetricSamples(input, connection.id, resource.id, technicalPeriodStart),
  });

  const technicalMetricSummaries: TechnicalMetricSummaryItem[] = [
    { metricName: 'CPUUtilization', metricUnit: 'Percent', base: 8, offset: 0 },
    { metricName: 'MemoryUtilization', metricUnit: 'Percent', base: 20, offset: 1 },
    { metricName: 'NetworkIn', metricUnit: 'Bytes', base: 1024, offset: 2 },
  ].map((metric) => ({
    provider: input.provider,
    externalResourceId: input.resourceId,
    cloudResourceId: resource.id,
    cloudConnectionId: connection.id,
    resourceType: 'COMPUTE_INSTANCE',
    serviceName: input.serviceName,
    metricName: metric.metricName,
    metricUnit: metric.metricUnit,
    ...(input.provider === 'OCI' ? { providerNamespace: 'oci_computeagent' } : {}),
    statistic: 'MEAN',
    granularitySeconds: 1800,
    sampleCount: 7 * 48,
    coverageDays: 7,
    min: metric.base + metric.offset,
    max: metric.base + metric.offset + 11,
    avg: metric.base + metric.offset + 5.5,
    p50: metric.base + metric.offset + 5.5,
    p95: metric.base + metric.offset + 11,
    p99: metric.base + metric.offset + 11,
    latest: metric.base + metric.offset + 11,
    highUtilizationSampleCount: 0,
    highUtilizationRatio: 0,
    firstSampledAt: new Date(now.getTime() - 7 * 86400000),
    latestSampledAt: latestTechnicalSampleAt,
  }));
  const [technicalRuleEvaluation] = evaluateTechnicalOptimizationRules({
    summaries: technicalMetricSummaries,
    referenceDate: now,
  });
  if (technicalRuleEvaluation === undefined) {
    throw new Error('E2E fixture technical rule evaluation returned no resource result.');
  }
  const technicalRuleJson = technicalRuleEvaluation as unknown as Prisma.InputJsonValue;
  const technicalEvidenceRefs = technicalRuleEvaluation.technicalEvidenceRefs;
  const technicalMetricEvidence = technicalRuleEvaluation.metricSummary.map((summary, index) => ({
    ...summary,
    evidenceRef: technicalEvidenceRefs[index]!,
  }));

  const recommendation = await prisma.recommendation.create({
    data: {
      tenantId: input.tenantId,
      cloudAccountId: account.id,
      type: 'RIGHTSIZING',
      status: 'PENDING',
      severity: 'HIGH',
      title: `Revisar capacidad de ${input.resourceName}`,
      description: 'Las métricas sugieren revisar la capacidad. Validar la ventana de carga y el rendimiento antes de considerar un cambio.',
      estimatedMonthlySavings: new Prisma.Decimal(0),
      currency: 'USD',
      evidence: {
        e2eRunId: input.runId,
        evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
        maxEstimatedMonthlySavings: 0,
        cloudResourceId: resource.id,
        externalResourceId: input.resourceId,
        deterministicRules: technicalRuleJson,
        costEvidenceRefs: [`cost_metrics:e2e-fixture:${input.runId}:${input.resourceId}`],
        technicalEvidenceRefs,
        technicalSampleCount: 7 * 48,
        technicalCoverageDays: 7,
        latestTechnicalSampleAt: latestTechnicalSampleAt.toISOString(),
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
            cost: { totalCost: 157.5, currency: 'USD', focusMetricCount: 14 },
            usage: [],
            metrics: technicalMetricEvidence,
            ruleEvaluation: technicalRuleJson,
          }],
          deterministicRules: [technicalRuleJson],
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
        summary: 'Validar la capacidad antes de considerar una optimización.',
        scope: {
          cloudAccountId: account.id,
          externalResourceId: input.resourceId,
          service: input.serviceName,
        },
        prerequisites: ['Confirmar propietario del servicio.', 'Revisar metricas de CPU y memoria.'],
        steps: ['Registrar la configuración actual.', 'Si existe aprobación externa explícita, evaluar una alternativa reversible.', 'Monitorear el servicio después de la validación.'],
        validation: ['Comparar CPU, memoria, errores y costo diario.'],
        risks: ['Degradacion si el patron de carga cambia.'],
        rollback: ['Restaurar el shape/tamano previo.'],
        successCriteria: ['Mantener el rendimiento y documentar la decisión técnica.'],
        estimatedSavings: { amount: 0, currency: 'USD', status: 'POTENTIAL_NOT_VERIFIED', note: 'No hay un cálculo determinístico de ahorro validado.' },
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
  cloudConnectionId: string,
  cloudResourceId: string,
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
      cloudConnectionId,
      cloudResourceId,
      provider: input.provider,
      serviceName: input.serviceName,
      resourceId: input.resourceId,
      resourceName: input.resourceName,
      resourceType: 'COMPUTE_INSTANCE',
      regionId: input.provider === 'AWS' ? 'us-east-1' : 'us-ashburn-1',
      chargePeriodStart: start,
      chargePeriodEnd: end,
      billingPeriodStart: periodStart,
      billingPeriodEnd: new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1)),
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

  return metricNames.flatMap((metric, metricIndex) => Array.from({ length: 14 * 48 }, (_, index) => {
    const sampledAt = new Date(periodStart);
    sampledAt.setUTCMinutes(sampledAt.getUTCMinutes() + index * 30);
    const base = metric.name === 'CPUUtilization' ? 8 : metric.name === 'MemoryUtilization' ? 20 : 1024;
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

function recentFixturePeriodStart(referenceDate: Date): Date {
  const periodStart = new Date(referenceDate);
  periodStart.setUTCDate(periodStart.getUTCDate() - 13);
  periodStart.setUTCHours(0, 0, 0, 0);
  return periodStart;
}
