export interface OperationalMigrationSnapshot {
  readonly expectedMigration?: string;
  readonly latestAppliedMigration?: string;
  readonly failedMigrations: number;
  readonly expectedMigrationApplied: boolean | undefined;
}

export interface OperationalReadinessSnapshot {
  readonly currentUser?: string;
  readonly migrations: OperationalMigrationSnapshot;
  readonly leaseAcquirable: boolean;
}

/** Infraestructura mínima que el endpoint de readiness necesita observar. */
export interface IOperationalReadinessRepository {
  inspect(expectedMigration?: string): Promise<OperationalReadinessSnapshot>;
}
