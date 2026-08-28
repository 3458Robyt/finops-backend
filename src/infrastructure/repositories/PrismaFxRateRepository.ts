import type { PrismaClient } from '../../generated/prisma/client.js';
import type { FxRateRecord, IFxRateRepository } from '../../domain/interfaces/IFxRateRepository.js';

export class PrismaFxRateRepository implements IFxRateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findRates(input: {
    readonly baseCurrency: string;
    readonly quoteCurrency: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<readonly FxRateRecord[]> {
    const rows = await this.prisma.fxRate.findMany({
      where: {
        baseCurrency: input.baseCurrency,
        quoteCurrency: input.quoteCurrency,
        validFrom: { lt: input.to },
        OR: [{ validTo: null }, { validTo: { gt: input.from } }],
      },
      orderBy: { validFrom: 'asc' },
    });

    return rows.map((row) => ({
      baseCurrency: row.baseCurrency,
      quoteCurrency: row.quoteCurrency,
      rate: Number(row.rate),
      validFrom: row.validFrom,
      validTo: row.validTo,
      source: row.source,
      ...(row.sourceUrl === null ? {} : { sourceUrl: row.sourceUrl }),
      retrievedAt: row.retrievedAt,
    }));
  }

  public async upsertRates(rates: readonly FxRateRecord[]): Promise<void> {
    for (const rate of rates) {
      await this.prisma.fxRate.upsert({
        where: {
          baseCurrency_quoteCurrency_validFrom_source: {
            baseCurrency: rate.baseCurrency,
            quoteCurrency: rate.quoteCurrency,
            validFrom: rate.validFrom,
            source: rate.source,
          },
        },
        create: {
          baseCurrency: rate.baseCurrency,
          quoteCurrency: rate.quoteCurrency,
          rate: rate.rate,
          validFrom: rate.validFrom,
          ...(rate.validTo === null ? {} : { validTo: rate.validTo }),
          source: rate.source,
          ...(rate.sourceUrl === undefined ? {} : { sourceUrl: rate.sourceUrl }),
          retrievedAt: rate.retrievedAt,
        },
        update: {
          rate: rate.rate,
          ...(rate.validTo === null ? { validTo: null } : { validTo: rate.validTo }),
          ...(rate.sourceUrl === undefined ? {} : { sourceUrl: rate.sourceUrl }),
          retrievedAt: rate.retrievedAt,
        },
      });
    }
  }
}
