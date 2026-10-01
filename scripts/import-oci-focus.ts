import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CostAnalyticsService } from '../src/application/services/CostAnalyticsService.js';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import {
  buildOciCostMetricIdentityHash,
  buildOciFocusLineHash,
  parseOciFocusReportFile,
  type OciFocusReportRow,
} from '../src/infrastructure/ingestion/ociFocusReport.js';
import { PrismaCostAnalyticsRepository } from '../src/infrastructure/repositories/PrismaCostAnalyticsRepository.js';
import { Argon2PasswordHasher } from '../src/infrastructure/security/Argon2PasswordHasher.js';
import {
  CloudAccountStatus,
  CloudProvider,
  DataQualityStatus,
  IngestionJobStatus,
  IngestionSourceType,
  IngestionStatus,
  Prisma,
  ProviderCapability,
  TenantStatus,
  UserRole,
  UserStatus,
} from '../src/generated/prisma/client.js';

interface ImportOptions {
  readonly connectionName: string;
  readonly defaultRegion: string;
  readonly focusVersion: string;
  readonly password: string;
  readonly reportsDir: string;
  readonly rootExternalId: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly userEmail: string;
  readonly userName: string;
}

interface ImportCounters {
  filesFailed: number;
  filesRead: number;
  metricRowsAttempted: number;
  metricRowsInserted: number;
  rawRows: number;
  skippedRows: number;
  focusRowsAttempted: number;
  focusRowsInserted: number;
}

const defaultRootExternalId = process.env['OCI_PERSONAL_TENANCY_OCID'] ?? '';
const defaultReportsDir = path.join('downloads', 'oci-focus', 'FOCUS Reports');
const batchSize = 1_000;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const reportsDir = path.resolve(options.reportsDir);
  const files = await findReportFiles(reportsDir);

  if (files.length === 0) {
    throw new Error(`No .csv or .csv.gz OCI FOCUS reports were found in ${reportsDir}`);
  }

  const prisma = getPrismaClient();
  const hasher = new Argon2PasswordHasher();
  const now = new Date();
  let ingestionRunId: string | null = null;

  try {
    await prisma.providerCatalog.upsert({
      where: { code: 'oci' },
      update: {
        capabilities: [
          ProviderCapability.FOCUS_EXPORT,
          ProviderCapability.INVENTORY,
          ProviderCapability.TECHNICAL_METRICS,
        ],
        defaultFocusVersion: options.focusVersion,
        displayName: 'Oracle Cloud Infrastructure',
        enabled: true,
        provider: CloudProvider.OCI,
      },
      create: {
        capabilities: [
          ProviderCapability.FOCUS_EXPORT,
          ProviderCapability.INVENTORY,
          ProviderCapability.TECHNICAL_METRICS,
        ],
        code: 'oci',
        defaultFocusVersion: options.focusVersion,
        displayName: 'Oracle Cloud Infrastructure',
        documentationUrl: 'https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/focuscostreportsoverview.htm',
        enabled: true,
        provider: CloudProvider.OCI,
      },
    });

    const tenant = await prisma.tenant.upsert({
      where: { slug: options.tenantSlug },
      update: {
        name: options.tenantName,
        status: TenantStatus.ACTIVE,
      },
      create: {
        name: options.tenantName,
        slug: options.tenantSlug,
        status: TenantStatus.ACTIVE,
      },
    });

    const passwordHash = await hasher.hash(options.password);
    const user = await prisma.user.upsert({
      where: { email: options.userEmail },
      update: {
        name: options.userName,
        passwordHash,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        tenantId: tenant.id,
      },
      create: {
        email: options.userEmail,
        name: options.userName,
        passwordHash,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        tenantId: tenant.id,
      },
    });

    const cloudAccount = await prisma.cloudAccount.upsert({
      where: {
        tenantId_provider_externalAccountId: {
          externalAccountId: options.rootExternalId,
          provider: CloudProvider.OCI,
          tenantId: tenant.id,
        },
      },
      update: {
        defaultRegion: options.defaultRegion,
        name: options.connectionName,
        status: CloudAccountStatus.ACTIVE,
      },
      create: {
        defaultRegion: options.defaultRegion,
        externalAccountId: options.rootExternalId,
        name: options.connectionName,
        provider: CloudProvider.OCI,
        status: CloudAccountStatus.ACTIVE,
        tenantId: tenant.id,
      },
    });

    const cloudConnection = await prisma.cloudConnection.upsert({
      where: {
        tenantId_providerCode_rootExternalId: {
          providerCode: 'oci',
          rootExternalId: options.rootExternalId,
          tenantId: tenant.id,
        },
      },
      update: {
        defaultRegion: options.defaultRegion,
        metadata: {
          importMode: 'local-focus-reports',
          lastImportAt: now.toISOString(),
          reportsDir,
          source: 'oci-focus-wizard',
        },
        name: options.connectionName,
        status: CloudAccountStatus.ACTIVE,
      },
      create: {
        defaultRegion: options.defaultRegion,
        metadata: {
          importMode: 'local-focus-reports',
          lastImportAt: now.toISOString(),
          reportsDir,
          source: 'oci-focus-wizard',
        },
        name: options.connectionName,
        providerCode: 'oci',
        rootExternalId: options.rootExternalId,
        status: CloudAccountStatus.ACTIVE,
        tenantId: tenant.id,
      },
    });

    const exportConfig = await upsertExportConfig({
      cloudConnectionId: cloudConnection.id,
      focusVersion: options.focusVersion,
      lastDeliveredAt: now,
      reportsDir,
    });

    const ingestionRun = await prisma.ingestionRun.create({
      data: {
        cloudAccountId: cloudAccount.id,
        cloudConnectionId: cloudConnection.id,
        provider: CloudProvider.OCI,
        status: IngestionStatus.RUNNING,
        targetDate: dateOnlyUtc(now),
        tenantId: tenant.id,
        trigger: 'manual-local-oci-focus-import',
      },
    });
    ingestionRunId = ingestionRun.id;

    const counters: ImportCounters = {
      filesFailed: 0,
      filesRead: 0,
      focusRowsAttempted: 0,
      focusRowsInserted: 0,
      metricRowsAttempted: 0,
      metricRowsInserted: 0,
      rawRows: 0,
      skippedRows: 0,
    };
    let minChargePeriodStart: Date | null = null;
    let maxChargePeriodEnd: Date | null = null;

    for (const filePath of files) {
      const fileHash = await sha256File(filePath);
      const objectUri = buildObjectUri(reportsDir, filePath, options.rootExternalId);

      const ingestionObject = await prisma.ingestionObject.upsert({
        where: {
          cloudConnectionId_objectUri_objectEtag: {
            cloudConnectionId: cloudConnection.id,
            objectEtag: fileHash,
            objectUri,
          },
        },
        update: {
          contentHash: fileHash,
          errorMessage: null,
          exportConfigId: exportConfig.id,
          sourceType: IngestionSourceType.BILLING_EXPORT,
          status: IngestionJobStatus.RUNNING,
        },
        create: {
          cloudConnectionId: cloudConnection.id,
          contentHash: fileHash,
          exportConfigId: exportConfig.id,
          objectEtag: fileHash,
          objectUri,
          sourceType: IngestionSourceType.BILLING_EXPORT,
          status: IngestionJobStatus.RUNNING,
          tenantId: tenant.id,
        },
      });

      try {
        const parsed = await parseOciFocusReportFile(filePath);
        counters.filesRead += 1;
        counters.rawRows += parsed.rawRowCount;
        counters.skippedRows += parsed.skippedRowCount;

        const focusRows: Prisma.FocusCostLineItemCreateManyInput[] = [];
        const costRows: Prisma.CostMetricCreateManyInput[] = [];

        for (const row of parsed.rows) {
          const lineItemHash = buildOciFocusLineHash(row);
          const metricIdentityHash = buildOciCostMetricIdentityHash({
            cloudAccountId: cloudAccount.id,
            lineItemHash,
            tenantId: tenant.id,
          });

          minChargePeriodStart = minDate(minChargePeriodStart, row.chargePeriodStart);
          maxChargePeriodEnd = maxDate(maxChargePeriodEnd, row.chargePeriodEnd);
          focusRows.push(toFocusCostLineItemInput({
            cloudConnectionId: cloudConnection.id,
            focusVersion: options.focusVersion,
            lineItemHash,
            row,
            tenantId: tenant.id,
          }));
          costRows.push(toCostMetricInput({
            cloudAccountId: cloudAccount.id,
            ingestionRunId: ingestionRun.id,
            lineItemHash,
            metricIdentityHash,
            objectUri,
            row,
            tenantId: tenant.id,
          }));
        }

        counters.focusRowsAttempted += focusRows.length;
        counters.metricRowsAttempted += costRows.length;
        counters.focusRowsInserted += await insertFocusRows(focusRows);
        counters.metricRowsInserted += await insertCostRows(costRows);

        await prisma.ingestionObject.update({
          where: { id: ingestionObject.id },
          data: {
            processedAt: new Date(),
            rowsProcessed: parsed.rows.length,
            status: IngestionJobStatus.SUCCESS,
          },
        });
      } catch (error) {
        counters.filesFailed += 1;

        await prisma.ingestionObject.update({
          where: { id: ingestionObject.id },
          data: {
            errorMessage: errorMessage(error),
            processedAt: new Date(),
            status: IngestionJobStatus.FAILED,
          },
        });
      }
    }

    const targetStart = minChargePeriodStart ?? now;
    const targetEnd = maxChargePeriodEnd ?? now;
    const importStatus = counters.filesFailed === 0 ? IngestionStatus.SUCCESS : IngestionStatus.FAILED;
    const jobStatus = counters.filesFailed === 0 ? IngestionJobStatus.SUCCESS : IngestionJobStatus.FAILED;

    await prisma.ingestionRun.update({
      where: { id: ingestionRun.id },
      data: {
        completedAt: new Date(),
        errorMessage: counters.filesFailed === 0 ? null : `${counters.filesFailed} OCI FOCUS files failed to import.`,
        metricsCount: counters.metricRowsInserted,
        status: importStatus,
      },
    });

    await prisma.ingestionJob.create({
      data: {
        attempts: 1,
        cloudConnectionId: cloudConnection.id,
        errorMessage: counters.filesFailed === 0 ? null : `${counters.filesFailed} OCI FOCUS files failed to import.`,
        lockedBy: 'local-import-oci-focus',
        maxAttempts: 1,
        requestedByUserId: user.id,
        sourceType: IngestionSourceType.BILLING_EXPORT,
        status: jobStatus,
        targetEnd,
        targetStart,
        tenantId: tenant.id,
      },
    });

    if (counters.metricRowsInserted > 0) {
      await updateWatermark({
        cloudConnectionId: cloudConnection.id,
        end: targetEnd,
        start: targetStart,
        tenantId: tenant.id,
      });
    }

    await recordDataQualityChecks({
      cloudConnectionId: cloudConnection.id,
      counters,
      end: targetEnd,
      start: targetStart,
      tenantId: tenant.id,
      userId: user.id,
    });

    const analyticsService = new CostAnalyticsService(new PrismaCostAnalyticsRepository(prisma));
    const analytics = await analyticsService.recompute({ tenantId: tenant.id });

    printSummary({
      analytics,
      cloudAccountId: cloudAccount.id,
      cloudConnectionId: cloudConnection.id,
      counters,
      end: targetEnd,
      files: files.length,
      start: targetStart,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      userEmail: user.email,
    });
  } catch (error) {
    if (ingestionRunId !== null) {
      await prisma.ingestionRun.update({
        where: { id: ingestionRunId },
        data: {
          completedAt: new Date(),
          errorMessage: errorMessage(error),
          status: IngestionStatus.FAILED,
        },
      });
    }

    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

function parseArgs(args: readonly string[]): ImportOptions {
  const options = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];

    if (key === undefined || !key.startsWith('--')) {
      if (key !== undefined) {
        positional.push(key);
      }
      continue;
    }

    const value = args[index + 1];

    if (value === undefined || value.startsWith('--')) {
      options.set(key.slice(2), 'true');
    } else {
      options.set(key.slice(2), value);
      index += 1;
    }
  }

  const rootExternalId = options.get('root-external-id') ?? positional[0] ?? defaultRootExternalId;
  const password = options.get('password') ?? process.env['OCI_FOCUS_IMPORT_PASSWORD'];

  if (rootExternalId.trim() === '') {
    throw new Error(
      'Missing --root-external-id. Pass the OCI tenancy OCID or set OCI_PERSONAL_TENANCY_OCID.',
    );
  }

  if (password === undefined || password.trim() === '') {
    throw new Error('Missing --password or OCI_FOCUS_IMPORT_PASSWORD for the import user');
  }

  return {
    connectionName: options.get('connection-name') ?? 'OCI Personal - FOCUS Reports',
    defaultRegion: options.get('default-region') ?? 'sa-bogota-1',
    focusVersion: options.get('focus-version') ?? '1.0',
    password,
    reportsDir: options.get('reports-dir') ?? positional[1] ?? defaultReportsDir,
    rootExternalId,
    tenantName: options.get('tenant-name') ?? 'OCI Demo Tenant',
    tenantSlug: options.get('tenant-slug') ?? 'oci-demo-tenant',
    userEmail: options.get('user-email') ?? 'test-user-0004@example.test',
    userName: options.get('user-name') ?? 'Demo Import Operator',
  };
}

async function findReportFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await findReportFiles(entryPath));
    } else if (entry.isFile() && /\.csv(?:\.gz)?$/iu.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function sha256File(filePath: string): Promise<string> {
  const fileStat = await stat(filePath);

  if (!fileStat.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }

  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

function buildObjectUri(reportsDir: string, filePath: string, rootExternalId: string): string {
  const objectName = path.relative(path.dirname(reportsDir), filePath).split(path.sep).join('/');
  return `oci://bling/${rootExternalId}/${objectName}`;
}

async function upsertExportConfig(input: {
  readonly cloudConnectionId: string;
  readonly focusVersion: string;
  readonly lastDeliveredAt: Date;
  readonly reportsDir: string;
}) {
  const existing = await getPrismaClient().cloudExportConfig.findFirst({
    where: {
      cloudConnectionId: input.cloudConnectionId,
      exportPath: 'FOCUS Reports',
      sourceType: IngestionSourceType.BILLING_EXPORT,
    },
  });

  if (existing !== null) {
    return getPrismaClient().cloudExportConfig.update({
      where: { id: existing.id },
      data: {
        focusVersion: input.focusVersion,
        lastDeliveredAt: input.lastDeliveredAt,
        status: CloudAccountStatus.ACTIVE,
      },
    });
  }

  return getPrismaClient().cloudExportConfig.create({
    data: {
      exportPath: 'FOCUS Reports',
      externalExportId: path.resolve(input.reportsDir),
      focusVersion: input.focusVersion,
      lastDeliveredAt: input.lastDeliveredAt,
      schedule: 'local-manual',
      sourceType: IngestionSourceType.BILLING_EXPORT,
      status: CloudAccountStatus.ACTIVE,
      cloudConnectionId: input.cloudConnectionId,
    },
  });
}

function toFocusCostLineItemInput(input: {
  readonly cloudConnectionId: string;
  readonly focusVersion: string;
  readonly lineItemHash: string;
  readonly row: OciFocusReportRow;
  readonly tenantId: string;
}): Prisma.FocusCostLineItemCreateManyInput {
  return {
    billedCost: input.row.billedCost,
    billingAccountId: input.row.billingAccountId,
    billingCurrency: input.row.billingCurrency,
    billingPeriodEnd: input.row.billingPeriodEnd,
    billingPeriodStart: input.row.billingPeriodStart,
    chargeCategory: input.row.chargeCategory,
    chargePeriodEnd: input.row.chargePeriodEnd,
    chargePeriodStart: input.row.chargePeriodStart,
    cloudConnectionId: input.cloudConnectionId,
    consumedQuantity: input.row.usageQuantity,
    consumedUnit: input.row.usageUnit,
    contractedCost: input.row.contractedCost,
    effectiveCost: input.row.effectiveCost,
    focusVersion: input.focusVersion,
    lineItemHash: input.lineItemHash,
    listCost: input.row.listCost,
    provider: CloudProvider.OCI,
    rawRow: input.row.rawRow as Prisma.InputJsonValue,
    regionId: input.row.regionId,
    resourceId: input.row.resourceId,
    serviceName: input.row.serviceName,
    subAccountId: input.row.subAccountId,
    tags: input.row.tags as Prisma.InputJsonValue,
    tenantId: input.tenantId,
  };
}

function toCostMetricInput(input: {
  readonly cloudAccountId: string;
  readonly ingestionRunId: string;
  readonly lineItemHash: string;
  readonly metricIdentityHash: string;
  readonly objectUri: string;
  readonly row: OciFocusReportRow;
  readonly tenantId: string;
}): Prisma.CostMetricCreateManyInput {
  return {
    availabilityZone: input.row.availabilityZone,
    billedCost: input.row.billedCost,
    billingAccountId: input.row.billingAccountId,
    billingAccountName: input.row.billingAccountName,
    billingCurrency: input.row.billingCurrency,
    billingPeriodEnd: input.row.billingPeriodEnd,
    billingPeriodStart: input.row.billingPeriodStart,
    chargeCategory: input.row.chargeCategory,
    chargeClass: input.row.chargeSubcategory,
    chargeFrequency: input.row.chargeFrequency,
    chargePeriodEnd: input.row.chargePeriodEnd,
    chargePeriodStart: input.row.chargePeriodStart,
    cloudAccountId: input.cloudAccountId,
    consumedQuantity: input.row.usageQuantity,
    consumedUnit: input.row.usageUnit,
    contractedCost: input.row.contractedCost,
    effectiveCost: input.row.effectiveCost,
    ingestionRunId: input.ingestionRunId,
    listCost: input.row.listCost,
    metricIdentityHash: input.metricIdentityHash,
    pricingQuantity: input.row.pricingQuantity,
    pricingUnit: input.row.pricingUnit,
    provider: CloudProvider.OCI,
    providerRaw: {
      chargeDescription: input.row.chargeDescription,
      focusSource: 'oci-focus-report',
      lineItemHash: input.lineItemHash,
      objectUri: input.objectUri,
      oci: input.row.oci,
    } as Prisma.InputJsonValue,
    regionId: input.row.regionId,
    resourceId: input.row.resourceId,
    resourceName: input.row.resourceName,
    resourceType: input.row.resourceType,
    serviceCategory: input.row.serviceCategory,
    serviceName: input.row.serviceName,
    sourceMetric: 'OCI_FOCUS_BILLED_COST',
    subAccountId: input.row.subAccountId,
    subAccountName: input.row.subAccountName,
    tags: input.row.tags as Prisma.InputJsonValue,
    tenantId: input.tenantId,
  };
}

async function insertFocusRows(rows: readonly Prisma.FocusCostLineItemCreateManyInput[]): Promise<number> {
  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const result = await getPrismaClient().focusCostLineItem.createMany({
      data: rows.slice(offset, offset + batchSize),
      skipDuplicates: true,
    });
    inserted += result.count;
  }

  return inserted;
}

async function insertCostRows(rows: readonly Prisma.CostMetricCreateManyInput[]): Promise<number> {
  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const result = await getPrismaClient().costMetric.createMany({
      data: rows.slice(offset, offset + batchSize),
      skipDuplicates: true,
    });
    inserted += result.count;
  }

  return inserted;
}

async function updateWatermark(input: {
  readonly cloudConnectionId: string;
  readonly end: Date;
  readonly start: Date;
  readonly tenantId: string;
}): Promise<void> {
  await getPrismaClient().ingestionWatermark.upsert({
    where: {
      cloudConnectionId_sourceType: {
        cloudConnectionId: input.cloudConnectionId,
        sourceType: IngestionSourceType.BILLING_EXPORT,
      },
    },
    update: {
      freshnessDeadlineAt: addDays(input.end, 2),
      lastSuccessfulRunAt: new Date(),
      watermarkEnd: input.end,
      watermarkStart: input.start,
    },
    create: {
      cloudConnectionId: input.cloudConnectionId,
      freshnessDeadlineAt: addDays(input.end, 2),
      lastSuccessfulRunAt: new Date(),
      sourceType: IngestionSourceType.BILLING_EXPORT,
      tenantId: input.tenantId,
      watermarkEnd: input.end,
      watermarkStart: input.start,
    },
  });
}

async function recordDataQualityChecks(input: {
  readonly cloudConnectionId: string;
  readonly counters: ImportCounters;
  readonly end: Date;
  readonly start: Date;
  readonly tenantId: string;
  readonly userId: string;
}): Promise<void> {
  const prisma = getPrismaClient();
  const common = {
    cloudConnectionId: input.cloudConnectionId,
    createdByUserId: input.userId,
    sourceType: IngestionSourceType.BILLING_EXPORT,
    tenantId: input.tenantId,
  };

  await prisma.dataQualityCheck.createMany({
    data: [
      {
        ...common,
        checkName: 'oci_focus_files_read',
        details: {
          failedFiles: input.counters.filesFailed,
          filesRead: input.counters.filesRead,
        } as Prisma.InputJsonValue,
        status: input.counters.filesRead > 0 ? DataQualityStatus.PASSED : DataQualityStatus.FAILED,
      },
      {
        ...common,
        checkName: 'oci_focus_rows_parsed',
        details: {
          dateRange: {
            end: input.end.toISOString(),
            start: input.start.toISOString(),
          },
          focusRowsAttempted: input.counters.focusRowsAttempted,
          focusRowsInserted: input.counters.focusRowsInserted,
          rawRows: input.counters.rawRows,
          skippedRows: input.counters.skippedRows,
        } as Prisma.InputJsonValue,
        status: input.counters.focusRowsInserted > 0 ? DataQualityStatus.PASSED : DataQualityStatus.FAILED,
      },
      {
        ...common,
        checkName: 'oci_focus_duplicate_control',
        details: {
          duplicateFocusRows: input.counters.focusRowsAttempted - input.counters.focusRowsInserted,
          duplicateMetricRows: input.counters.metricRowsAttempted - input.counters.metricRowsInserted,
          method: 'natural-line-hash',
        } as Prisma.InputJsonValue,
        status: DataQualityStatus.PASSED,
      },
      {
        ...common,
        checkName: 'oci_focus_file_errors',
        details: {
          failedFiles: input.counters.filesFailed,
        } as Prisma.InputJsonValue,
        status: input.counters.filesFailed === 0 ? DataQualityStatus.PASSED : DataQualityStatus.WARNING,
      },
    ],
  });
}

function minDate(current: Date | null, candidate: Date): Date {
  return current === null || candidate.getTime() < current.getTime() ? candidate : current;
}

function maxDate(current: Date | null, candidate: Date): Date {
  return current === null || candidate.getTime() > current.getTime() ? candidate : current;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function dateOnlyUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printSummary(input: {
  readonly analytics: Awaited<ReturnType<CostAnalyticsService['recompute']>>;
  readonly cloudAccountId: string;
  readonly cloudConnectionId: string;
  readonly counters: ImportCounters;
  readonly end: Date;
  readonly files: number;
  readonly start: Date;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly userEmail: string;
}): void {
  console.log('OCI FOCUS import completed.');
  console.log(`  Tenant:           ${input.tenantSlug} (${input.tenantId})`);
  console.log(`  Cloud account:    ${input.cloudAccountId}`);
  console.log(`  Cloud connection: ${input.cloudConnectionId}`);
  console.log(`  Login email:      ${input.userEmail}`);
  console.log(`  Files found:      ${input.files}`);
  console.log(`  Files read:       ${input.counters.filesRead}`);
  console.log(`  Files failed:     ${input.counters.filesFailed}`);
  console.log(`  Raw rows:         ${input.counters.rawRows}`);
  console.log(`  Skipped rows:     ${input.counters.skippedRows}`);
  console.log(`  FOCUS inserted:   ${input.counters.focusRowsInserted}/${input.counters.focusRowsAttempted}`);
  console.log(`  Metrics inserted: ${input.counters.metricRowsInserted}/${input.counters.metricRowsAttempted}`);
  console.log(`  Date range:       ${input.start.toISOString()} -> ${input.end.toISOString()}`);
  console.log(`  Analytics:        ${input.analytics.anomalies.length} anomalies, ${input.analytics.forecasts.length} forecasts`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
