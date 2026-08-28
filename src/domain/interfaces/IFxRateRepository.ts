export interface FxRateRecord {
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rate: number;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly source: string;
  readonly sourceUrl?: string;
  readonly retrievedAt: Date;
}

export interface IFxRateRepository {
  findRates(input: {
    readonly baseCurrency: string;
    readonly quoteCurrency: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<readonly FxRateRecord[]>;

  upsertRates(rates: readonly FxRateRecord[]): Promise<void>;
}
