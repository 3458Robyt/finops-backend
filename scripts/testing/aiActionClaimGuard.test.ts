import { describe, expect, test } from 'vitest';
import { claimsCompletedCloudAction } from './aiActionClaimGuard.js';

describe('claimsCompletedCloudAction', () => {
  test.each([
    ['He redimensionado la instancia.', true],
    ['La instancia fue apagada.', true],
    ['No he apagado la instancia.', false],
    ['No he ejecutado cambios cloud.', false],
    ['No lo he apagado; puedo orientarte.', false],
    ['No puedo ejecutar cambios cloud desde el chat.', false],
  ])('classifies safely: %s', (answer, expected) => {
    expect(claimsCompletedCloudAction(answer)).toBe(expected);
  });
});
