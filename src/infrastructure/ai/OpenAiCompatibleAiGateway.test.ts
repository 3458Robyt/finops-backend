import { afterEach, describe, expect, test, vi } from 'vitest';

const { openAiConstructor } = vi.hoisted(() => ({
  openAiConstructor: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    public constructor(options: unknown) {
      openAiConstructor(options);
    }

    public readonly chat = {
      completions: {
        create: vi.fn(),
      },
    };
  },
}));

describe('OpenAiCompatibleAiGateway', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    openAiConstructor.mockClear();
    vi.resetModules();
  });

  test('uses generic AI configuration as the primary provider settings', async () => {
    process.env['AI_API_KEY'] = 'test-ai-key';
    process.env['AI_BASE_URL'] = 'https://api.example.test/v1';
    process.env['AI_MODEL'] = 'gpt-5.4-mini';
    process.env['AI_TIMEOUT_MS'] = '15000';
    process.env['AI_MAX_RETRIES'] = '0';
    process.env['NVIDIA_API_KEY'] = 'legacy-key';
    process.env['NVIDIA_MODEL'] = 'legacy-model';

    const { OpenAiCompatibleAiGateway } = await import('./OpenAiCompatibleAiGateway.js');
    const gateway = new OpenAiCompatibleAiGateway();

    expect(gateway.modelName).toBe('gpt-5.4-mini');
    expect(openAiConstructor).toHaveBeenCalledWith({
      apiKey: 'test-ai-key',
      baseURL: 'https://api.example.test/v1',
      timeout: 15000,
      maxRetries: 0,
    });
  });

  test('keeps legacy NVIDIA configuration as fallback', async () => {
    delete process.env['AI_API_KEY'];
    delete process.env['AI_BASE_URL'];
    delete process.env['AI_MODEL'];
    process.env['NVIDIA_API_KEY'] = 'legacy-key';
    process.env['NVIDIA_BASE_URL'] = 'https://legacy.example.test/v1';
    process.env['NVIDIA_MODEL'] = 'legacy-model';

    const { OpenAiCompatibleAiGateway } = await import('./OpenAiCompatibleAiGateway.js');
    const gateway = new OpenAiCompatibleAiGateway();

    expect(gateway.modelName).toBe('legacy-model');
    expect(openAiConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'legacy-key',
        baseURL: 'https://legacy.example.test/v1',
      }),
    );
  });
});
