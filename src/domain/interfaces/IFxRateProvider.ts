import type { FxRateRecord } from './IFxRateRepository.js';

export interface IFxRateProvider {
  loadUsdCopRates(from: Date, to: Date): Promise<readonly FxRateRecord[]>;
}
