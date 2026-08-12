import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  IOperationalReadinessRepository,
  OperationalReadinessSnapshot,
} from '../../domain/interfaces/IOperationalReadinessRepository.js';

interface MigrationRow {
  readonly migration_name: string;
}

interface CountRow {
  readonly failed_migrations: bigint | number;
}

interface LockRow {
  readonly acquired: boolean;
}

/** Read-only operational probes; no tenant data is exposed by readiness. */
export class PrismaOperationalReadinessRepository implements IOperationalReadinessRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async inspect(expectedMigration?: string): Promise<OperationalReadinessSnapshot> {
    return this.prisma.$transaction(async (transaction) => {
      const currentUserRows = await transaction.$queryRaw<Array<{ readonly current_user: string }>>`
        SELECT current_user
      `;
      const migrationRows = await transaction.$queryRaw<MigrationRow[]>`
        SELECT migration_name
        FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL
          AND rolled_back_at IS NULL
        ORDER BY finished_at DESC
        LIMIT 1
      `;
      const failedRows = await transaction.$queryRaw<CountRow[]>`
        SELECT count(*)::bigint AS failed_migrations
        FROM "_prisma_migrations"
        WHERE finished_at IS NULL
          AND rolled_back_at IS NULL
      `;
      const lockRows = await transaction.$queryRaw<LockRow[]>`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended('finops:readiness:' || txid_current()::text, 0)
        ) AS acquired
      `;
      const latestAppliedMigration = migrationRows[0]?.migration_name;
      const expectedMigrationApplied = expectedMigration === undefined
        ? undefined
        : latestAppliedMigration === expectedMigration;

      return {
        ...(currentUserRows[0]?.current_user === undefined ? {} : { currentUser: currentUserRows[0].current_user }),
        migrations: {
          ...(expectedMigration === undefined ? {} : { expectedMigration }),
          ...(latestAppliedMigration === undefined ? {} : { latestAppliedMigration }),
          failedMigrations: Number(failedRows[0]?.failed_migrations ?? 0),
          expectedMigrationApplied,
        },
        leaseAcquirable: lockRows[0]?.acquired === true,
      };
    });
  }
}
