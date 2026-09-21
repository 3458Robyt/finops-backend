import { afterEach, describe, expect, test, vi } from 'vitest';

const { openAiConstructor, completionCreate } = vi.hoisted(() => ({
  openAiConstructor: vi.fn(),
  completionCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    public constructor(options: unknown) {
      openAiConstructor(options);
    }

    public readonly chat = {
      completions: {
        create: completionCreate,
      },
    };
  },
}));

describe('OpenAiCompatibleAiGateway', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    openAiConstructor.mockClear();
    completionCreate.mockReset();
    vi.resetModules();
  });

  test('uses generic AI configuration as the primary provider settings', async () => {
    process.env['AI_API_KEY'] = 'test-ai-key';
    process.env['AI_BASE_URL'] = 'https://api.example.test/v1';
    process.env['AI_MODEL'] = 'gpt-5.6-luna';
    process.env['AI_TIMEOUT_MS'] = '15000';
    process.env['AI_MAX_RETRIES'] = '0';
    process.env['NVIDIA_API_KEY'] = 'legacy-key';
    process.env['NVIDIA_MODEL'] = 'legacy-model';

    const { OpenAiCompatibleAiGateway } = await import('./OpenAiCompatibleAiGateway.js');
    const gateway = new OpenAiCompatibleAiGateway();

    expect(gateway.modelName).toBe('gpt-5.6-luna');
    expect(openAiConstructor).toHaveBeenCalledWith({
      apiKey: 'test-ai-key',
      baseURL: 'https://api.example.test/v1',
      timeout: 15000,
      maxRetries: 0,
    });
  });

  test('does not silently use removed legacy NVIDIA configuration', async () => {
    delete process.env['AI_API_KEY'];
    delete process.env['AI_BASE_URL'];
    delete process.env['AI_MODEL'];
    process.env['NVIDIA_API_KEY'] = 'legacy-key';
    process.env['NVIDIA_BASE_URL'] = 'https://legacy.example.test/v1';
    process.env['NVIDIA_MODEL'] = 'legacy-model';

    const { OpenAiCompatibleAiGateway } = await import('./OpenAiCompatibleAiGateway.js');

    expect(() => new OpenAiCompatibleAiGateway()).toThrow('AI_API_KEY must be configured');
    expect(openAiConstructor).not.toHaveBeenCalled();
  });

  test('sends only the standard OpenAI-compatible payload', async () => {
    process.env['AI_API_KEY'] = 'test-ai-key';
    process.env['AI_BASE_URL'] = 'https://api.example.test/v1';
    process.env['AI_MODEL'] = 'gpt-5.6-luna';
    completionCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'respuesta' } }] };
    })());

    const { OpenAiCompatibleAiGateway } = await import('./OpenAiCompatibleAiGateway.js');
    const gateway = new OpenAiCompatibleAiGateway();
    await gateway.generateText({ messages: [{ role: 'user', content: 'hola' }] });

    expect(completionCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ chat_template_kwargs: expect.anything() }),
      expect.anything(),
    );
    expect(completionCreate.mock.calls[0]?.[0]).toMatchObject({ model: 'gpt-5.6-luna', stream: true });
  });

  test('requests JSON mode for structured AI artifacts', async () => {
    process.env['AI_API_KEY'] = 'test-ai-key';
    process.env['AI_BASE_URL'] = 'https://api.example.test/v1';
    completionCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: '{}' } }] };
    })());

    const { OpenAiCompatibleAiGateway } = await import('./OpenAiCompatibleAiGateway.js');
    const gateway = new OpenAiCompatibleAiGateway();
    await gateway.generateText({
      responseFormat: 'json',
      messages: [{ role: 'user', content: 'devuelve JSON' }],
    });

    expect(completionCreate.mock.calls[0]?.[0]).toMatchObject({
      response_format: { type: 'json_object' },
    });
  });

  test('forwards the optional reasoning effort without changing standard requests', async () => {
    process.env['AI_API_KEY'] = 'test-ai-key';
    process.env['AI_BASE_URL'] = 'https://api.example.test/v1';
    completionCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: '{}' } }] };
    })());

    const { OpenAiCompatibleAiGateway } = await import('./OpenAiCompatibleAiGateway.js');
    const gateway = new OpenAiCompatibleAiGateway();
    await gateway.generateText({
      reasoningEffort: 'low',
      messages: [{ role: 'user', content: 'responde' }],
    });

    expect(completionCreate.mock.calls[0]?.[0]).toMatchObject({ reasoning_effort: 'low' });
  });

  test('aborts a streaming request at its request timeout', async () => {
    vi.useFakeTimers();
    process.env['AI_API_KEY'] = 'test-ai-key';
    process.env['AI_BASE_URL'] = 'https://api.example.test/v1';
    completionCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        await new Promise<never>(() => undefined);
      },
    });

    const { OpenAiCompatibleAiGateway } = await import('./OpenAiCompatibleAiGateway.js');
    const gateway = new OpenAiCompatibleAiGateway();
    const pending = gateway.generateText({
      timeoutMs: 25,
      messages: [{ role: 'user', content: 'espera' }],
    });
    pending.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      message: 'La solicitud al proveedor de IA excedió el tiempo máximo configurado',
    });
    const requestOptions = completionCreate.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(requestOptions).toEqual(expect.objectContaining({
      signal: expect.any(AbortSignal),
      timeout: 25,
    }));
    expect(requestOptions.signal?.aborted).toBe(true);
  });
});
