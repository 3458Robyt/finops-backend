import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import {
  buildCostMetricSeedRows,
  downloadFocusSampleCsv,
  FOCUS_SAMPLE_URL,
  parseFocusSampleCsv,
  type FocusSampleRow,
} from '../src/infrastructure/seed/focusSample.js';
import { Argon2PasswordHasher } from '../src/infrastructure/security/Argon2PasswordHasher.js';
import {
  CloudProvider,
  RecommendationSeverity,
  RecommendationStatus,
  UserRole,
} from '../src/generated/prisma/client.js';

const prisma = getPrismaClient();
const passwordHasher = new Argon2PasswordHasher();

type SeedEnvironment = 'prod' | 'dev';

async function main(): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-org' },
    update: {},
    create: {
      name: 'FinOps Demo',
      slug: 'demo-org',
    },
  });

  const defaultPassword = process.env['SEED_DEFAULT_PASSWORD'];

  if (defaultPassword === undefined || defaultPassword.trim() === '') {
    throw new Error('SEED_DEFAULT_PASSWORD must be set before running the seed');
  }

  const passwordHash = await passwordHasher.hash(defaultPassword);

  await prisma.user.upsert({
    where: { email: 'test-user-0004@example.test' },
    update: {
      passwordHash,
      role: UserRole.MASTER_ADMIN,
      tenantId: tenant.id,
      status: 'ACTIVE',
    },
    create: {
      tenantId: tenant.id,
      email: 'test-user-0004@example.test',
      name: 'Demo Administrator',
      passwordHash,
      role: UserRole.MASTER_ADMIN,
    },
  });

  await prisma.user.upsert({
    where: { email: 'test-user-0011@example.test' },
    update: {
      passwordHash,
      role: UserRole.CLIENT_VIEWER,
      tenantId: tenant.id,
      status: 'ACTIVE',
    },
    create: {
      tenantId: tenant.id,
      email: 'test-user-0011@example.test',
      name: 'Ejecutivo Cliente',
      passwordHash,
      role: UserRole.CLIENT_VIEWER,
    },
  });

  const cloudAccounts = await seedCloudAccounts(tenant.id);
  const focusRows = await loadFocusRows();
  const insertedMetrics = await seedCostMetrics(tenant.id, cloudAccounts, focusRows);
  const recommendationCount = await seedRecommendations(tenant.id, cloudAccounts, focusRows);

  console.log('Seed completed. Default password source: SEED_DEFAULT_PASSWORD');
  console.log(`FOCUS source: ${process.env['FOCUS_SAMPLE_CSV_URL'] ?? FOCUS_SAMPLE_URL}`);
  console.log(`Supported FOCUS rows parsed: ${focusRows.length}`);
  console.log(`Cost metrics inserted: ${insertedMetrics}`);
  console.log(`Demo recommendations upserted: ${recommendationCount}`);
}

async function seedCloudAccounts(
  tenantId: string,
): Promise<ReadonlyMap<string, string>> {
  const accounts = [
    {
      provider: CloudProvider.AWS,
      environment: 'prod' as const,
      externalAccountId: 'focus-sample-aws-prod',
      name: 'TAK - Prod Principal (FOCUS AWS)',
      defaultRegion: 'us-east-1',
    },
    {
      provider: CloudProvider.AWS,
      environment: 'dev' as const,
      externalAccountId: 'focus-sample-aws-dev',
      name: 'TAK - Dev/Staging (FOCUS AWS)',
      defaultRegion: 'us-west-2',
    },
    {
      provider: CloudProvider.OCI,
      environment: 'prod' as const,
      externalAccountId: 'focus-sample-oci-prod',
      name: 'TAK - Prod Principal (FOCUS OCI)',
      defaultRegion: 'us-ashburn-1',
    },
    {
      provider: CloudProvider.OCI,
      environment: 'dev' as const,
      externalAccountId: 'focus-sample-oci-dev',
      name: 'TAK - Dev/Staging (FOCUS OCI)',
      defaultRegion: 'us-ashburn-1',
    },
  ];

  const accountIds = new Map<string, string>();

  for (const account of accounts) {
    const cloudAccount = await prisma.cloudAccount.upsert({
      where: {
        tenantId_provider_externalAccountId: {
          tenantId,
          provider: account.provider,
          externalAccountId: account.externalAccountId,
        },
      },
      update: {
        name: account.name,
        defaultRegion: account.defaultRegion,
        status: 'ACTIVE',
      },
      create: {
        tenantId,
        provider: account.provider,
        externalAccountId: account.externalAccountId,
        name: account.name,
        defaultRegion: account.defaultRegion,
      },
    });

    accountIds.set(accountKey(account.provider, account.environment), cloudAccount.id);
  }

  return accountIds;
}

async function loadFocusRows(): Promise<FocusSampleRow[]> {
  const csv = await downloadFocusSampleCsv();
  return parseFocusSampleCsv(csv);
}

async function seedCostMetrics(
  tenantId: string,
  cloudAccounts: ReadonlyMap<string, string>,
  rows: readonly FocusSampleRow[],
): Promise<number> {
  let inserted = 0;

  for (const provider of [CloudProvider.AWS, CloudProvider.OCI]) {
    for (const environment of ['prod', 'dev'] as const) {
      const cloudAccountId = cloudAccounts.get(accountKey(provider, environment));

      if (cloudAccountId === undefined) {
        continue;
      }

      const environmentRows = rows.filter((row) => (
        row.providerName === provider && inferEnvironment(row) === environment
      ));

      if (environmentRows.length === 0) {
        continue;
      }

      const result = await prisma.costMetric.createMany({
        data: buildCostMetricSeedRows({
          rows: environmentRows,
          tenantId,
          cloudAccountId,
        }),
        skipDuplicates: true,
      });

      inserted += result.count;
    }
  }

  return inserted;
}

async function seedRecommendations(
  tenantId: string,
  cloudAccounts: ReadonlyMap<string, string>,
  rows: readonly FocusSampleRow[],
): Promise<number> {
  const templates = [
    {
      id: 'demo-focus-ec2-rightsizing',
      serviceIncludes: 'Elastic Compute Cloud',
      type: 'COMPUTE_RIGHTSIZING',
      severity: RecommendationSeverity.HIGH,
      title: 'Rightsizing de EC2 priorizado',
      description: 'El dataset FOCUS público muestra alta concentración de gasto en EC2. Conviene revisar familias, tamaños y horarios antes de automatizar apagados.',
      estimatedSavingsRate: 0.15,
      metric: 'Concentración de gasto compute',
      action: 'Rightsizing y scheduler',
    },
    {
      id: 'demo-focus-rds-storage-review',
      serviceIncludes: 'Relational Database Service',
      type: 'DATABASE_STORAGE_REVIEW',
      severity: RecommendationSeverity.MEDIUM,
      title: 'Revisión de capacidad RDS',
      description: 'RDS aparece como uno de los servicios con mayor costo en la muestra. La siguiente acción es validar tamaño, almacenamiento y reservas antes de ajustar.',
      estimatedSavingsRate: 0.12,
      metric: 'Gasto administrado en base de datos',
      action: 'Rightsizing de instancia y storage',
    },
    {
      id: 'demo-focus-network-review',
      serviceIncludes: 'Virtual Private Cloud',
      type: 'NETWORK_COST_REVIEW',
      severity: RecommendationSeverity.MEDIUM,
      title: 'Control de costos de red',
      description: 'Los cargos de VPC deben revisarse con NAT, transferencia y patrones de salida para separar consumo real de arquitectura ineficiente.',
      estimatedSavingsRate: 0.1,
      metric: 'Costos de red acumulados',
      action: 'Revisar NAT, endpoints y egress',
    },
    {
      id: 'demo-focus-storage-lifecycle',
      serviceIncludes: 'Simple Storage Service',
      type: 'STORAGE_LIFECYCLE',
      severity: RecommendationSeverity.LOW,
      title: 'Políticas de ciclo de vida S3',
      description: 'La muestra incluye consumo S3 suficiente para modelar reglas de lifecycle. Debe validarse edad, acceso y retención antes de mover objetos.',
      estimatedSavingsRate: 0.08,
      metric: 'Costo storage por servicio',
      action: 'Lifecycle hacia tiers fríos',
    },
  ];

  const totalCost = sumCost(rows);
  const period = getSamplePeriod(rows);
  let upserted = 0;

  for (const template of templates) {
    const matchingRows = rows.filter((row) => row.serviceName.includes(template.serviceIncludes));

    if (matchingRows.length === 0) {
      continue;
    }

    const serviceCost = sumCost(matchingRows);
    const dominantProvider = getDominantProvider(matchingRows);
    const dominantEnvironment = getDominantEnvironment(matchingRows);
    const cloudAccountId = cloudAccounts.get(accountKey(dominantProvider, dominantEnvironment));

    if (cloudAccountId === undefined) {
      continue;
    }

    const evidence = {
      serviceCost,
      totalCost,
      shareOfSupportedCost: totalCost > 0 ? roundCurrency(serviceCost / totalCost) : 0,
      environment: dominantEnvironment,
      metric: template.metric,
      action: template.action,
      samplePeriodStart: period.start.toISOString(),
      samplePeriodEnd: period.end.toISOString(),
      source: process.env['FOCUS_SAMPLE_CSV_URL'] ?? FOCUS_SAMPLE_URL,
    };

    await prisma.recommendation.upsert({
      where: { id: template.id },
      update: {
        tenantId,
        cloudAccountId,
        origin: 'DEMO_SEEDED',
        type: template.type,
        status: RecommendationStatus.PENDING,
        severity: template.severity,
        title: template.title,
        description: template.description,
        evidence,
        estimatedMonthlySavings: roundCurrency(serviceCost * template.estimatedSavingsRate),
        currency: 'USD',
      },
      create: {
        id: template.id,
        tenantId,
        cloudAccountId,
        origin: 'DEMO_SEEDED',
        type: template.type,
        status: RecommendationStatus.PENDING,
        severity: template.severity,
        title: template.title,
        description: template.description,
        evidence,
        estimatedMonthlySavings: roundCurrency(serviceCost * template.estimatedSavingsRate),
        currency: 'USD',
      },
    });

    upserted += 1;
  }

  return upserted;
}

function accountKey(provider: CloudProvider, environment: SeedEnvironment): string {
  return `${provider}:${environment}`;
}

function inferEnvironment(row: FocusSampleRow): SeedEnvironment {
  const environment = row.tags['environment']?.trim().toLowerCase();
  return environment === 'prod' ? 'prod' : 'dev';
}

function sumCost(rows: readonly FocusSampleRow[]): number {
  return roundCurrency(rows.reduce((total, row) => total + row.billedCost, 0));
}

function getDominantProvider(rows: readonly FocusSampleRow[]): CloudProvider {
  return maxByCost(rows, (row) => row.providerName) ?? CloudProvider.AWS;
}

function getDominantEnvironment(rows: readonly FocusSampleRow[]): SeedEnvironment {
  return maxByCost(rows, inferEnvironment) ?? 'dev';
}

function maxByCost<T extends string>(
  rows: readonly FocusSampleRow[],
  keySelector: (row: FocusSampleRow) => T,
): T | undefined {
  const totals = new Map<T, number>();

  for (const row of rows) {
    const key = keySelector(row);
    totals.set(key, (totals.get(key) ?? 0) + row.billedCost);
  }

  let maxKey: T | undefined;
  let maxCost = Number.NEGATIVE_INFINITY;

  for (const [key, cost] of totals.entries()) {
    if (cost > maxCost) {
      maxKey = key;
      maxCost = cost;
    }
  }

  return maxKey;
}

function getSamplePeriod(rows: readonly FocusSampleRow[]): { start: Date; end: Date } {
  const timestamps = rows.flatMap((row) => [
    row.chargePeriodStart.getTime(),
    row.chargePeriodEnd.getTime(),
  ]);

  if (timestamps.length === 0) {
    const now = new Date();
    return { start: now, end: now };
  }

  return {
    start: new Date(Math.min(...timestamps)),
    end: new Date(Math.max(...timestamps)),
  };
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
