import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import type { ICostAnalyticsRepository } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/costAnalytics/costAnalyticsModels.js';
import type { AiTraceRecorder } from './aiTraceRecorder.js';
import type { FinOpsContextAssembler } from './finOpsContextAssembler.js';
import { FinOpsAiChatRunner } from './FinOpsAiChatRunner.js';

const observedThrough = new Date('2026-09-23T00:00:00.000Z');

function snapshot(periodStart: string, periodEnd: string): CostAnalyticsSnapshot {
  return {
    tenantId: 'tenant-1',
    periodStart,
    periodEnd,
    totalCost: 0,
    currency: 'COP',
    metricCount: 0,
    providers: [],
    accounts: [],
    services: [],
    environments: [],
    topResources: [],
  };
}

function createRunner(
  latest: CostAnalyticsSnapshot,
  ranged: CostAnalyticsSnapshot,
  latestObserved = observedThrough,
) {
  const repository = {
    getLatestTenantSnapshot: vi.fn(async () => latest),
    getLatestObservedThrough: vi.fn(async () => latestObserved),
    getTenantSnapshotForPeriod: vi.fn(async () => ranged),
  } as unknown as ICostAnalyticsRepository;
  const contextAssembler = {
    assembleChatContext: vi.fn(async () => ({ builtContext: undefined, systemPrompt: 'prompt' })),
  } as unknown as FinOpsContextAssembler;
  const gateway = {
    modelName: 'test-model',
    generateText: vi.fn(async () => 'El costo observado está limitado por el periodo disponible.'),
  } as unknown as IAiGateway;
  const traceRecorder = { record: vi.fn(async () => undefined) } as unknown as AiTraceRecorder;

  return {
    repository,
    contextAssembler,
    traceRecorder,
    runner: new FinOpsAiChatRunner(repository, gateway, contextAssembler, traceRecorder, 'test-model'),
  };
}

describe('FinOpsAiChatRunner requested cost period', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-09-23T12:00:00.000Z')));
  afterEach(() => vi.useRealTimers());

  test('uses the requested 90-day window ending at the latest observed charge', async () => {
    const latest = snapshot('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const ranged = snapshot('2026-06-25T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
    const { repository, contextAssembler, runner } = createRunner(latest, ranged);

    const result = await runner.run({ tenantId: 'tenant-1', message: '¿Cuál es el costo de los últimos 90 días disponibles?' });

    expect(repository.getTenantSnapshotForPeriod).toHaveBeenCalledWith(
      'tenant-1',
      new Date('2026-06-25T00:00:00.000Z'),
      observedThrough,
    );
    expect(contextAssembler.assembleChatContext).toHaveBeenCalledWith(expect.objectContaining({ snapshot: ranged }));
    expect(result.snapshot).toBe(ranged);
  });

  test('loads the requested named month instead of the latest-month snapshot', async () => {
    const latest = snapshot('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    const september = snapshot('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const observed = new Date('2026-10-03T00:00:00.000Z');
    const { repository, runner } = createRunner(latest, september, observed);

    const result = await runner.run({ tenantId: 'tenant-1', message: '¿Qué costos hubo en septiembre?' });

    expect(repository.getTenantSnapshotForPeriod).toHaveBeenCalledWith(
      'tenant-1',
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-10-01T00:00:00.000Z'),
    );
    expect(result.snapshot).toBe(september);
  });

  test('uses the explicit year and clamps a partially observed month to available data', async () => {
    const latest = snapshot('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const september = snapshot('2025-09-01T00:00:00.000Z', '2025-10-01T00:00:00.000Z');
    const observed = new Date('2026-09-23T00:00:00.000Z');
    const { repository, runner } = createRunner(latest, september, observed);

    await runner.run({ tenantId: 'tenant-1', message: 'Dame el resumen de septiembre de 2025' });

    expect(repository.getTenantSnapshotForPeriod).toHaveBeenCalledWith(
      'tenant-1',
      new Date('2025-09-01T00:00:00.000Z'),
      new Date('2025-10-01T00:00:00.000Z'),
    );
  });

  test('does not substitute the latest snapshot when the explicitly requested future month has no data yet', async () => {
    const latest = snapshot('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    const future = snapshot('2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    const observed = new Date('2026-10-03T00:00:00.000Z');
    const { repository, runner } = createRunner(latest, future, observed);

    const result = await runner.run({ tenantId: 'tenant-1', message: '¿Qué gasto hubo en diciembre de 2026?' });

    expect(repository.getTenantSnapshotForPeriod).toHaveBeenCalledWith(
      'tenant-1',
      new Date('2026-12-01T00:00:00.000Z'),
      new Date('2027-01-01T00:00:00.000Z'),
    );
    expect(result.snapshot).toBe(future);
  });

  test('keeps the latest month snapshot when no relative day range is requested', async () => {
    const latest = snapshot('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const { repository, runner } = createRunner(latest, snapshot('2026-06-25T00:00:00.000Z', '2026-09-23T00:00:00.000Z'));

    const result = await runner.run({ tenantId: 'tenant-1', message: '¿Cuál es el costo del servicio principal?' });

    expect(repository.getTenantSnapshotForPeriod).not.toHaveBeenCalled();
    expect(result.snapshot).toBe(latest);
  });

  test('records the trusted caller channel in the chat trace', async () => {
    const latest = snapshot('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const { runner, traceRecorder } = createRunner(latest, latest);

    await runner.run({ tenantId: 'tenant-1', userId: 'user-1', traceSource: 'WEB', message: 'Hola' });

    expect(traceRecorder.record).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'CHAT',
      source: 'WEB',
    }));
  });
});
