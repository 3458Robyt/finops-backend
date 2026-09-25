import { describe, expect, it } from 'vitest';
import { assertLocalFinopsDatabaseTarget, assertLocalMutationTarget } from './assertLocalMutationTarget.js';

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

describe('assertLocalFinopsDatabaseTarget', () => {
  it('permits only the configured local development database', () => {
    expect(() => assertLocalFinopsDatabaseTarget(
      'postgresql://postgres:secret@127.0.0.1:5433/finops_local?schema=finops_e2e_test',
    )).not.toThrow();
  });

  it.each([
    undefined,
    'not-a-url',
    'postgresql://postgres:secret@db.example.com:5433/finops_local',
    'http://postgres:secret@127.0.0.1:5433/finops_local',
    'postgresql://postgres:secret@127.0.0.1:5432/finops_local',
    'postgresql://postgres:secret@127.0.0.1:5433/postgres',
  ])('rejects an unexpected database target (%s)', (connectionString) => {
    expect(() => assertLocalFinopsDatabaseTarget(connectionString)).toThrow(
      'DATABASE_URL debe apuntar a PostgreSQL local 127.0.0.1:5433/finops_local.',
    );
  });
});
