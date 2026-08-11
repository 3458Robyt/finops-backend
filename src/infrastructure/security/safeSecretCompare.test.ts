import { describe, expect, it } from 'vitest';
import { safeSecretEqual } from './safeSecretCompare.js';

describe('safeSecretEqual', () => {
  it('accepts only an exact secret and rejects missing or differently-sized values', () => {
    expect(safeSecretEqual('telegram-secret', 'telegram-secret')).toBe(true);
    expect(safeSecretEqual('telegram-secret', 'telegram-secreT')).toBe(false);
    expect(safeSecretEqual('telegram-secret', undefined)).toBe(false);
  });
});
