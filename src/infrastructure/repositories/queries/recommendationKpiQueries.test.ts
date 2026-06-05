/**
 * Tests de la logica computable de los KPIs de recomendaciones.
 *
 * computeSavingsKpis y computeAdoptionKpis reciben el PrismaClient por
 * parametro (inyeccion de dependencia), asi que se prueban con un stub manual
 * de Prisma (mismo patron de fakes + `as unknown as` que usa el resto del
 * proyecto, p.ej. SavingsReminderService.test.ts) sin necesidad de base de
 * datos. El filtrado por estado de las consultas vive en el `where` de Prisma
 * (no es JS puro), por lo que aqui se valida lo realmente computable: la
 * derivacion de conteos/tasas de adopcion y el calculo/redondeo del ahorro
 * perdido y la seleccion de la recomendacion con mayor ahorro perdido.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { computeAdoptionKpis, computeSavingsKpis } from './recommendationKpiQueries.js';

/** Fila minima de recomendacion que consume computeSavingsKpis (findMany). */
interface SavingsRecRow {
  readonly id: string;
  readonly title: string;
  readonly estimatedMonthlySavings: number;
  readonly currency: string;
  readonly status: string;
  readonly createdAt: Date;
}

/** Fila de groupBy por estado que consume computeAdoptionKpis. */
interface StatusCountRow {
  readonly status: string;
  readonly _count: number;
}

/**
 * Construye un stub de PrismaClient con los resultados predefinidos para las
 * (5) consultas que ejecutan los KPIs. Solo implementa los metodos usados; se
 * castea `as unknown as PrismaClient` siguiendo la convencion del repo.
 */
function createPrismaStub(input: {
  readonly estimatedSum?: number | null;
  readonly observedSum?: number | null;
  readonly executedGroups?: number;
  readonly pendingRecs?: readonly SavingsRecRow[];
  readonly statusCounts?: readonly StatusCountRow[];
}): PrismaClient {
  const stub = {
    recommendation: {
      aggregate: async () => ({ _sum: { estimatedMonthlySavings: input.estimatedSum ?? null } }),
      findMany: async () => [...(input.pendingRecs ?? [])],
      groupBy: async () => [...(input.statusCounts ?? [])],
    },
    recommendationManualExecution: {
      aggregate: async () => ({ _sum: { observedMonthlySavings: input.observedSum ?? null } }),
      groupBy: async () => Array.from({ length: input.executedGroups ?? 0 }, (_unused, index) => ({ recommendationId: `rec-${index}` })),
    },
  };

  return stub as unknown as PrismaClient;
}

describe('computeAdoptionKpis', () => {
  it('cuenta solo APPROVED/REJECTED/MANUAL_COMPLETED como decididas y excluye PENDING del denominador', async () => {
    const prisma = createPrismaStub({
      statusCounts: [
        { status: 'PENDING', _count: 3 },
        { status: 'APPROVED', _count: 2 },
        { status: 'REJECTED', _count: 1 },
        { status: 'MANUAL_COMPLETED', _count: 4 },
      ],
    });

    const kpis = await computeAdoptionKpis(prisma, 'tenant-1');

    // decididas = APPROVED(2) + REJECTED(1) + MANUAL_COMPLETED(4) = 7; PENDING no cuenta.
    expect(kpis.totalRecommendations).toBe(10);
    expect(kpis.pendingRecommendations).toBe(3);
    expect(kpis.approvedRecommendations).toBe(2);
    expect(kpis.rejectedRecommendations).toBe(1);
    expect(kpis.completedRecommendations).toBe(4);
    // acceptanceRate = (APPROVED + MANUAL_COMPLETED) / decididas = 6/7.
    expect(kpis.acceptanceRate).toBeCloseTo(6 / 7, 10);
    // rejectionRate = REJECTED / decididas = 1/7.
    expect(kpis.rejectionRate).toBeCloseTo(1 / 7, 10);
    // executionRate = MANUAL_COMPLETED / total = 4/10.
    expect(kpis.executionRate).toBeCloseTo(0.4, 10);
  });

  it('devuelve tasas en 0 (sin NaN) cuando no hay recomendaciones', async () => {
    const prisma = createPrismaStub({ statusCounts: [] });

    const kpis = await computeAdoptionKpis(prisma, 'tenant-1');

    expect(kpis.totalRecommendations).toBe(0);
    expect(kpis.acceptanceRate).toBe(0);
    expect(kpis.rejectionRate).toBe(0);
    expect(kpis.executionRate).toBe(0);
    expect(Number.isNaN(kpis.acceptanceRate)).toBe(false);
  });

  it('trata como 0 los estados ausentes en el groupBy', async () => {
    const prisma = createPrismaStub({
      statusCounts: [{ status: 'PENDING', _count: 5 }],
    });

    const kpis = await computeAdoptionKpis(prisma, 'tenant-1');

    expect(kpis.totalRecommendations).toBe(5);
    expect(kpis.pendingRecommendations).toBe(5);
    expect(kpis.approvedRecommendations).toBe(0);
    expect(kpis.rejectedRecommendations).toBe(0);
    expect(kpis.completedRecommendations).toBe(0);
    // Sin decididas el denominador es 0 -> tasas 0.
    expect(kpis.acceptanceRate).toBe(0);
    expect(kpis.executionRate).toBe(0);
  });
});

describe('computeSavingsKpis', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expone los agregados, fija la divisa en USD y deriva los conteos de ejecutadas/pendientes', async () => {
    const prisma = createPrismaStub({
      estimatedSum: 1000,
      observedSum: 250,
      executedGroups: 2,
      pendingRecs: [],
    });

    const kpis = await computeSavingsKpis(prisma, 'tenant-1');

    expect(kpis.estimatedMonthlySavings).toBe(1000);
    expect(kpis.observedMonthlySavings).toBe(250);
    expect(kpis.confirmedMonthlySavings).toBe(250);
    expect(kpis.currency).toBe('USD');
    // executedRecommendations = numero de grupos del groupBy de ejecuciones.
    expect(kpis.executedRecommendations).toBe(2);
    // pendingSavingsRecommendations = numero de filas del findMany.
    expect(kpis.pendingSavingsRecommendations).toBe(0);
    expect(kpis.missedSavingsAmount).toBe(0);
    expect(kpis.topMissedSavingsRecommendation).toBeUndefined();
  });

  it('convierte sumas nulas de Prisma en 0', async () => {
    const prisma = createPrismaStub({ estimatedSum: null, observedSum: null });

    const kpis = await computeSavingsKpis(prisma, 'tenant-1');

    expect(kpis.estimatedMonthlySavings).toBe(0);
    expect(kpis.observedMonthlySavings).toBe(0);
    expect(kpis.confirmedMonthlySavings).toBe(0);
  });

  it('acumula el ahorro perdido prorrateado y destaca la recomendacion con mayor ahorro perdido', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const dayMs = 24 * 60 * 60 * 1000;

    const prisma = createPrismaStub({
      estimatedSum: 600,
      observedSum: 0,
      executedGroups: 0,
      pendingRecs: [
        {
          id: 'rec-top',
          title: 'Apagar recursos fuera de horario',
          estimatedMonthlySavings: 300,
          currency: 'USD',
          status: 'PENDING',
          // 60 dias sin ejecutar -> (300/30)*60 = 600.
          createdAt: new Date(now.getTime() - 60 * dayMs),
        },
        {
          id: 'rec-second',
          title: 'Eliminar volumen ocioso',
          estimatedMonthlySavings: 300,
          currency: 'USD',
          status: 'APPROVED',
          // 30 dias sin ejecutar -> (300/30)*30 = 300.
          createdAt: new Date(now.getTime() - 30 * dayMs),
        },
      ],
    });

    const kpis = await computeSavingsKpis(prisma, 'tenant-1');

    expect(kpis.pendingSavingsRecommendations).toBe(2);
    // missedSavingsAmount = 600 + 300 = 900.
    expect(kpis.missedSavingsAmount).toBe(900);
    expect(kpis.topMissedSavingsRecommendation).toMatchObject({
      id: 'rec-top',
      title: 'Apagar recursos fuera de horario',
      missedSavingsAmount: 600,
      estimatedMonthlySavings: 300,
      currency: 'USD',
      status: 'PENDING',
    });
  });

  it('descarta importes de ahorro perdido despreciables (< 0.01)', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const prisma = createPrismaStub({
      estimatedSum: 0,
      observedSum: 0,
      pendingRecs: [
        {
          id: 'rec-fresh',
          title: 'Recomendacion recien creada',
          estimatedMonthlySavings: 300,
          currency: 'USD',
          status: 'PENDING',
          // Creada justo ahora -> 0 dias transcurridos -> ahorro perdido 0.
          createdAt: now,
        },
      ],
    });

    const kpis = await computeSavingsKpis(prisma, 'tenant-1');

    expect(kpis.pendingSavingsRecommendations).toBe(1);
    expect(kpis.missedSavingsAmount).toBe(0);
    expect(kpis.topMissedSavingsRecommendation).toBeUndefined();
  });
});
