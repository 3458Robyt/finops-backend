import { describe, expect, it } from 'vitest';
import { AuthLifecycleCleanupService } from './AuthLifecycleCleanupService.js';
import type {
  AuthLifecycleCleanupInput,
  AuthLifecycleCleanupResult,
  IAuthLifecycleCleanupRepository,
} from '../../domain/interfaces/IAuthLifecycleCleanupRepository.js';

class FakeCleanupRepository implements IAuthLifecycleCleanupRepository {
  public input: AuthLifecycleCleanupInput | undefined;
  public result: AuthLifecycleCleanupResult = {
    refreshTokens: 2,
    passwordResetTokens: 1,
    mfaChallenges: 3,
    sessions: 4,
  };

  public purgeExpiredArtifacts(input: AuthLifecycleCleanupInput): Promise<AuthLifecycleCleanupResult> {
    this.input = input;
    return Promise.resolve(this.result);
  }
}

describe('AuthLifecycleCleanupService', () => {
  it('delegates a bounded cleanup batch with a stable timestamp', async () => {
    const repository = new FakeCleanupRepository();
    const service = new AuthLifecycleCleanupService(repository, 25);
    const now = new Date('2026-08-12T12:00:00.000Z');

    await expect(service.runOnce(now)).resolves.toEqual(repository.result);
    expect(repository.input).toEqual({ now, batchSize: 25 });
  });

  it('clamps an unsafe configured batch size', async () => {
    const repository = new FakeCleanupRepository();
    const service = new AuthLifecycleCleanupService(repository, 99_999);

    await service.runOnce();

    expect(repository.input?.batchSize).toBe(5000);
  });
});
