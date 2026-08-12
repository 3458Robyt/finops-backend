import type {
  AuthLifecycleCleanupInput,
  AuthLifecycleCleanupResult,
  IAuthLifecycleCleanupRepository,
} from '../../domain/interfaces/IAuthLifecycleCleanupRepository.js';

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5000;

/** Coordinates bounded cleanup of authentication-only ephemeral records. */
export class AuthLifecycleCleanupService {
  private readonly boundedBatchSize: number;

  public constructor(
    private readonly repository: IAuthLifecycleCleanupRepository,
    batchSize = DEFAULT_BATCH_SIZE,
  ) {
    const normalizedBatchSize = Number.isFinite(batchSize) ? Math.trunc(batchSize) : DEFAULT_BATCH_SIZE;
    this.boundedBatchSize = Math.min(MAX_BATCH_SIZE, Math.max(1, normalizedBatchSize));
  }

  public runOnce(now = new Date()): Promise<AuthLifecycleCleanupResult> {
    const input: AuthLifecycleCleanupInput = {
      now,
      batchSize: this.boundedBatchSize,
    };
    return this.repository.purgeExpiredArtifacts(input);
  }
}
