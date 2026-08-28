import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { ColombiaTrmProvider } from '../src/infrastructure/fx/ColombiaTrmProvider.js';
import { PrismaFxRateRepository } from '../src/infrastructure/repositories/PrismaFxRateRepository.js';

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  try {
    const bounds = await prisma.costMetric.aggregate({ _min: { chargePeriodStart: true }, _max: { chargePeriodStart: true } });
    const from = bounds._min.chargePeriodStart;
    const to = bounds._max.chargePeriodStart === null ? new Date() : new Date(bounds._max.chargePeriodStart.getTime() + 24 * 60 * 60 * 1000);
    if (from === null) {
      console.log(JSON.stringify({ success: true, imported: 0, reason: 'No hay costos para respaldar tasas.' }));
      return;
    }
    const provider = new ColombiaTrmProvider();
    const repository = new PrismaFxRateRepository(prisma);
    const rates = await provider.loadUsdCopRates(new Date(from.getTime() - 7 * 24 * 60 * 60 * 1000), to);
    await repository.upsertRates(rates);
    console.log(JSON.stringify({ success: true, imported: rates.length, from: from.toISOString(), to: to.toISOString(), source: 'SUPERFINANCIERA_TRM' }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
