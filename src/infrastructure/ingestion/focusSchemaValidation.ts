export const FOCUS_1_0_MANDATORY_COLUMNS = [
  'BilledCost',
  'BillingAccountId',
  'BillingAccountName',
  'BillingCurrency',
  'BillingPeriodEnd',
  'BillingPeriodStart',
  'ChargeCategory',
  'ChargeClass',
  'ChargePeriodEnd',
  'ChargePeriodStart',
  'ContractedCost',
  'EffectiveCost',
  'InvoiceIssuer',
  'PricingUnit',
  'Provider',
  'Publisher',
  'ServiceCategory',
  'ServiceName',
] as const;

export interface FocusSchemaHeaderAssessment {
  readonly status: 'CONFORMANT' | 'NONCONFORMANT' | 'UNVERIFIED';
  readonly missingMandatoryColumns: readonly string[];
}

export interface FocusSchemaValidationSummary {
  status: 'PENDING' | 'CONFORMANT' | 'NONCONFORMANT' | 'UNVERIFIED';
  filesChecked: number;
  filesConformant: number;
  filesNonconformant: number;
  filesUnverified: number;
  missingMandatoryColumns: string[];
}

const NONCONFORMANT_WARNING = 'FOCUS 1.0: uno o más archivos omiten columnas obligatorias. Se conservaron las filas disponibles, pero no se certifica conformidad; revisa el resumen de esquema del job.';
const UNVERIFIED_WARNING = 'No se verificó el esquema FOCUS para una versión no soportada; se conservaron las filas sin certificar conformidad.';

export function assessFocusSchemaHeader(
  version: string,
  headers: readonly string[],
): FocusSchemaHeaderAssessment {
  if (version !== '1.0') {
    return { status: 'UNVERIFIED', missingMandatoryColumns: [] };
  }

  const normalizedHeaders = new Set(headers.map((header) => header.trim().replace(/^\uFEFF/, '').toLowerCase()));
  const missingMandatoryColumns = FOCUS_1_0_MANDATORY_COLUMNS.filter(
    (column) => !normalizedHeaders.has(column.toLowerCase()),
  );

  return {
    status: missingMandatoryColumns.length === 0 ? 'CONFORMANT' : 'NONCONFORMANT',
    missingMandatoryColumns,
  };
}

export function createFocusSchemaValidationSummary(): FocusSchemaValidationSummary {
  return {
    status: 'PENDING',
    filesChecked: 0,
    filesConformant: 0,
    filesNonconformant: 0,
    filesUnverified: 0,
    missingMandatoryColumns: [],
  };
}

export function recordFocusSchemaAssessment(
  version: string,
  headers: readonly string[],
  summary: FocusSchemaValidationSummary,
  warnings: string[],
): void {
  const assessment = assessFocusSchemaHeader(version, headers);
  summary.filesChecked += 1;
  if (assessment.status === 'CONFORMANT') summary.filesConformant += 1;
  if (assessment.status === 'NONCONFORMANT') {
    summary.filesNonconformant += 1;
    for (const column of assessment.missingMandatoryColumns) {
      if (!summary.missingMandatoryColumns.includes(column)) summary.missingMandatoryColumns.push(column);
    }
    if (!warnings.includes(NONCONFORMANT_WARNING)) warnings.push(NONCONFORMANT_WARNING);
  }
  if (assessment.status === 'UNVERIFIED') {
    summary.filesUnverified += 1;
    if (!warnings.includes(UNVERIFIED_WARNING)) warnings.push(UNVERIFIED_WARNING);
  }
  summary.status = summary.filesNonconformant > 0
    ? 'NONCONFORMANT'
    : summary.filesUnverified > 0
      ? 'UNVERIFIED'
      : 'CONFORMANT';
}
