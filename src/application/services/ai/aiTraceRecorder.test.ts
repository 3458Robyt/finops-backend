import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AiObservabilityService } from '../AiObservabilityService.js';
import { AiTraceRecorder } from './aiTraceRecorder.js';

afterEach(() => vi.restoreAllMocks());

describe('AiTraceRecorder', () => {
  test('does not fail the AI interaction when trace persistence is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const observability = {
      recordTrace: vi.fn().mockRejectedValue(new Error('trace store unavailable')),
    } as unknown as AiObservabilityService;
    const recorder = new AiTraceRecorder(observability);

    await expect(recorder.record({
      tenantId: 'tenant-1',
      operation: 'CHAT',
      model: 'test-model',
      startedAt: Date.now(),
      responseText: 'Respuesta generada',
    })).resolves.toBeUndefined();

    expect(observability.recordTrace).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ai_trace_persistence_failed'));
  });
});
