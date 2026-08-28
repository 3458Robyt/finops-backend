import type { FxRateRecord } from '../../domain/interfaces/IFxRateRepository.js';
import type { IFxRateProvider } from '../../domain/interfaces/IFxRateProvider.js';

const DEFAULT_ENDPOINT = 'https://www.datos.gov.co/resource/32sa-8pi3.json';
const SOURCE = 'SUPERFINANCIERA_TRM';

export class ColombiaTrmProvider implements IFxRateProvider {
  constructor(
    private readonly endpoint = process.env['FX_TRM_ENDPOINT'] ?? DEFAULT_ENDPOINT,
    private readonly timeoutMs = Number(process.env['FX_TRM_TIMEOUT_MS'] ?? 10_000),
  ) {}

  public async loadUsdCopRates(from: Date, to: Date): Promise<readonly FxRateRecord[]> {
    const fromDate = toDateOnly(from);
    const toDate = toDateOnly(to);
    const url = new URL(this.endpoint);
    url.searchParams.set('$select', 'valor,unidad,vigenciadesde,vigenciahasta');
    url.searchParams.set('$limit', '5000');
    url.searchParams.set('$order', 'vigenciadesde asc');
    url.searchParams.set('$where', `vigenciadesde <= '${toDate}' AND vigenciadesde >= '${fromDate}'`);

    const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`TRM provider returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('TRM provider returned an invalid payload');

    const rows = payload.flatMap((item): FxRateRecord[] => {
      if (item === null || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const validFrom = parseDateOnly(row['vigenciadesde']);
      const rate = parseRate(row['valor']);
      if (validFrom === null || rate === null || rate <= 0) return [];
      const validTo = parseDateOnly(row['vigenciahasta']);
      return [
        {
          baseCurrency: 'USD',
          quoteCurrency: 'COP',
          rate,
          validFrom,
          validTo,
          source: SOURCE,
          sourceUrl: url.toString(),
          retrievedAt: new Date(),
        },
        {
          baseCurrency: 'COP',
          quoteCurrency: 'USD',
          rate: 1 / rate,
          validFrom,
          validTo,
          source: SOURCE,
          sourceUrl: url.toString(),
          retrievedAt: new Date(),
        },
      ];
    });

    return rows;
  }
}

function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match === null) return null;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseRate(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const normalized = trimmed.includes(',')
    ? trimmed.replace(/\./g, '').replace(',', '.')
    : trimmed;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
