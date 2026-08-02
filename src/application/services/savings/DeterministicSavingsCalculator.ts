import type {
  SavingsMeasurementStatus,
  SavingsMeasurementScope,
} from '../../../domain/interfaces/IRecommendationRepository.js';

export const savingsCalculationVersion = 'v1.0.0';
export const defaultSavingsWindowDays = 7;
export const monthlyDays = 30.4375;
export const minimumCoverageRatio = 0.8;
export const materialQuantityChangeRatio = 0.2;

export interface SavingsCostAggregate {
  readonly cost: number;
  readonly coveredDays: number;
  readonly sampleCount: number;
  readonly quantity?: number;
  readonly unit?: string;
}

export interface DeterministicSavingsInput {
  readonly scope: SavingsMeasurementScope;
  readonly windowDays: number;
  readonly baseline: SavingsCostAggregate;
  readonly observation: SavingsCostAggregate;
  readonly technicalSampleCount: number;
  readonly technicalEvidenceRequired: boolean;
  readonly technicalEvidenceAvailable?: boolean;
  readonly technicalCriticalSignal?: boolean;
}

export interface DeterministicSavingsResult {
  readonly status: SavingsMeasurementStatus;
  readonly baselineDailyCost?: number;
  readonly observationDailyCost?: number;
  readonly observedSavings?: number;
  readonly projectedMonthlySavings?: number;
  readonly costIncreaseMonthlyAmount?: number;
  readonly calculationMethod: 'COST_DELTA' | 'UNIT_NORMALIZED';
  readonly baselineUnitCost?: number;
  readonly observationUnitCost?: number;
  readonly quantityChangeRatio?: number;
  readonly coverageRatio: number;
  readonly confidence: number;
  readonly confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  readonly technicalValidationStatus: 'AVAILABLE' | 'NOT_AVAILABLE' | 'CRITICAL_SIGNALS' | 'NOT_REQUIRED';
  readonly reasons: readonly string[];
  readonly formula: {
    readonly version: string;
    readonly baselineDailyCost: string;
    readonly observationDailyCost: string;
    readonly observedSavings: string;
    readonly projectedMonthlySavings: string;
  };
}

/**
 * Calcula únicamente con agregados ya filtrados por tenant, cuenta, fuente y
 * ventana. No consulta red ni IA y deja el resultado reproducible/auditable.
 */
export function calculateDeterministicSavings(input: DeterministicSavingsInput): DeterministicSavingsResult {
  const reasons: string[] = [];
  const coverageRatio = Math.min(
    input.baseline.coveredDays / input.windowDays,
    input.observation.coveredDays / input.windowDays,
  );
  const technicalValidationStatus = input.technicalEvidenceRequired
    ? input.technicalCriticalSignal === true ? 'CRITICAL_SIGNALS' : input.technicalEvidenceAvailable === false ? 'NOT_AVAILABLE' : input.technicalSampleCount > 0 ? 'AVAILABLE' : 'NOT_AVAILABLE'
    : 'NOT_REQUIRED';

  if (input.baseline.coveredDays === 0) reasons.push('No hay datos de costo en la ventana base.');
  if (input.observation.coveredDays === 0) reasons.push('No hay datos de costo posteriores a la ejecución.');
  if (input.observation.coveredDays > 0 && input.observation.coveredDays < input.windowDays) {
    reasons.push('La ventana posterior todavía no está completa.');
  }
  if (coverageRatio < minimumCoverageRatio) {
    reasons.push(`La cobertura (${Math.round(coverageRatio * 100)}%) está por debajo del mínimo del 80%.`);
  }
  if (input.technicalEvidenceRequired && technicalValidationStatus === 'NOT_AVAILABLE') {
    reasons.push('No hay métricas técnicas posteriores para validar seguridad operativa.');
  }
  if (input.technicalEvidenceRequired && technicalValidationStatus === 'CRITICAL_SIGNALS') {
    reasons.push('Las métricas técnicas muestran señales de saturación; el resultado no demuestra una optimización segura.');
  }

  if (input.baseline.coveredDays === 0 || input.observation.coveredDays === 0) {
    return buildResult('WAITING_FOR_DATA', coverageRatio, technicalValidationStatus, reasons);
  }

  const baselineDailyCost = input.baseline.cost / input.baseline.coveredDays;
  const observationDailyCost = input.observation.cost / input.observation.coveredDays;
  const observedDailyDelta = baselineDailyCost - observationDailyCost;
  const observedSavings = observedDailyDelta * input.observation.coveredDays;
  const signedProjectedMonthlySavings = observedDailyDelta * monthlyDays;
  const projectedMonthlySavings = Math.max(0, signedProjectedMonthlySavings);
  const costIncreaseMonthlyAmount = signedProjectedMonthlySavings < 0 ? Math.abs(signedProjectedMonthlySavings) : 0;
  let calculationMethod: 'COST_DELTA' | 'UNIT_NORMALIZED' = 'COST_DELTA';
  let baselineUnitCost: number | undefined;
  let observationUnitCost: number | undefined;
  let quantityChangeRatio: number | undefined;
  let unitComparisonInsufficient = false;

  if (input.baseline.unit !== undefined || input.observation.unit !== undefined) {
    if (input.baseline.unit !== input.observation.unit) {
      reasons.push('La unidad de consumo cambió y no se puede comparar eficiencia directamente.');
      unitComparisonInsufficient = true;
    } else if (input.baseline.quantity !== undefined && input.observation.quantity !== undefined) {
      calculationMethod = 'UNIT_NORMALIZED';
      const baselineQuantity = Math.abs(input.baseline.quantity);
      if (baselineQuantity > 0) {
        baselineUnitCost = input.baseline.cost / baselineQuantity;
        observationUnitCost = input.observation.cost / Math.abs(input.observation.quantity || 1);
        quantityChangeRatio = Math.abs(input.observation.quantity - input.baseline.quantity) / baselineQuantity;
        if (quantityChangeRatio > materialQuantityChangeRatio) {
          reasons.push('El volumen consumido cambió más del 20%; el resultado financiero no prueba una mejora de eficiencia.');
          unitComparisonInsufficient = true;
        }
      }
    }
  }

  if (signedProjectedMonthlySavings < 0) {
    reasons.push('El costo posterior aumentó; no se puede verificar un ahorro positivo.');
  }
  const technicalInsufficient = input.technicalEvidenceRequired &&
    (technicalValidationStatus !== 'AVAILABLE' || input.technicalEvidenceAvailable === false);
  const status: SavingsMeasurementStatus = coverageRatio < minimumCoverageRatio || technicalInsufficient || unitComparisonInsufficient
    ? 'INSUFFICIENT_EVIDENCE'
    : 'CALCULATED';
  const confidence = status === 'INSUFFICIENT_EVIDENCE'
    ? 0.45
    : signedProjectedMonthlySavings < 0 ? 0.55 : technicalValidationStatus === 'AVAILABLE' ? 0.9 : technicalValidationStatus === 'CRITICAL_SIGNALS' ? 0.5 : 0.75;
  const confidenceLevel = confidence >= 0.85 ? 'HIGH' : confidence >= 0.65 ? 'MEDIUM' : 'LOW';

  return {
    status,
    baselineDailyCost,
    observationDailyCost,
    observedSavings,
    projectedMonthlySavings,
    costIncreaseMonthlyAmount,
    calculationMethod,
    ...(baselineUnitCost !== undefined ? { baselineUnitCost } : {}),
    ...(observationUnitCost !== undefined ? { observationUnitCost } : {}),
    ...(quantityChangeRatio !== undefined ? { quantityChangeRatio } : {}),
    coverageRatio,
    confidence,
    confidenceLevel,
    technicalValidationStatus,
    reasons,
    formula: {
      version: savingsCalculationVersion,
      baselineDailyCost: 'baselineCost / baselineCoveredDays',
      observationDailyCost: 'observationCost / observationCoveredDays',
      observedSavings: '(baselineDailyCost - observationDailyCost) * observationCoveredDays',
      projectedMonthlySavings: 'observedSavings * 30.4375',
    },
  };
}

function buildResult(
  status: SavingsMeasurementStatus,
  coverageRatio: number,
  technicalValidationStatus: DeterministicSavingsResult['technicalValidationStatus'],
  reasons: readonly string[],
): DeterministicSavingsResult {
  return {
    status,
    coverageRatio,
    confidence: 0,
    confidenceLevel: 'LOW',
    technicalValidationStatus,
    calculationMethod: 'COST_DELTA',
    reasons,
    formula: {
      version: savingsCalculationVersion,
      baselineDailyCost: 'baselineCost / baselineCoveredDays',
      observationDailyCost: 'observationCost / observationCoveredDays',
      observedSavings: '(baselineDailyCost - observationDailyCost) * observationCoveredDays',
      projectedMonthlySavings: 'observedSavings * 30.4375',
    },
  };
}
