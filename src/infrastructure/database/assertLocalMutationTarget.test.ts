import { describe, expect, it } from 'vitest';
import { assertLocalMutationTarget } from './assertLocalMutationTarget.js';

describe('assertLocalMutationTarget', () => {
  it('permite hosts locales', () => {
    expect(() => assertLocalMutationTarget('postgresql://postgres:secret@127.0.0.1:5433/finops_local')).not.toThrow();
    expect(() => assertLocalMutationTarget('postgresql://postgres:secret@localhost/finops_local')).not.toThrow();
  });

  it('rechaza hosts remotos por defecto', () => {
    expect(() => assertLocalMutationTarget('postgresql://postgres:secret@db.example.com/finops')).toThrow(
      'Se rechazó una escritura manual contra la base remota db.example.com',
    );
  });

  it('solo permite un remoto mediante opt-in explícito', () => {
    expect(() => assertLocalMutationTarget('postgresql://postgres:secret@db.example.com/finops', true)).not.toThrow();
  });
});
