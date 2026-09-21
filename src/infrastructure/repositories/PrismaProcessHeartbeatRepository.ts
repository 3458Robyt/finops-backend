import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  IProcessHeartbeatRepository,
  ProcessHeartbeatRecord,
  ProcessHeartbeatStatus,
  UpsertProcessHeartbeatInput,
} from '../../domain/interfaces/IProcessHeartbeatRepository.js';

export class PrismaProcessHeartbeatRepository implements IProcessHeartbeatRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async upsert(input: UpsertProcessHeartbeatInput): Promise<void> {
    await this.prisma.runtimeProcessHeartbeat.upsert({
      where: { processId: input.processId },
      create: {
        processId: input.processId,
        processRole: input.processRole,
        ...(input.pid === undefined ? {} : { pid: input.pid }),
        startedAt: input.startedAt,
        lastHeartbeatAt: input.heartbeatAt,
      },
      update: {
        processRole: input.processRole,
        ...(input.pid === undefined ? {} : { pid: input.pid }),
        startedAt: input.startedAt,
        lastHeartbeatAt: input.heartbeatAt,
        status: 'RUNNING',
        stoppedAt: null,
      },
    });
  }

  public async markStopped(processId: string, stoppedAt: Date): Promise<boolean> {
    const result = await this.prisma.runtimeProcessHeartbeat.updateMany({
      where: { processId, status: 'RUNNING' },
      data: { status: 'STOPPED', stoppedAt, lastHeartbeatAt: stoppedAt },
    });
    return result.count === 1;
  }

  public async markStale(staleBefore: Date, stoppedAt: Date): Promise<number> {
    const result = await this.prisma.runtimeProcessHeartbeat.updateMany({
      where: {
        status: 'RUNNING',
        lastHeartbeatAt: { lt: staleBefore },
      },
      data: { status: 'STOPPED', stoppedAt },
    });
    return result.count;
  }

  public async findById(processId: string): Promise<ProcessHeartbeatRecord | null> {
    const row = await this.prisma.runtimeProcessHeartbeat.findUnique({ where: { processId } });
    return row === null ? null : toRecord(row);
  }

  public async findFreshByRoles(input: {
    readonly processRoles: readonly string[];
    readonly staleBefore: Date;
  }): Promise<ProcessHeartbeatRecord | null> {
    if (input.processRoles.length === 0) return null;
    const row = await this.prisma.runtimeProcessHeartbeat.findFirst({
      where: {
        processRole: { in: [...input.processRoles] },
        status: 'RUNNING',
        lastHeartbeatAt: { gte: input.staleBefore },
      },
      orderBy: { lastHeartbeatAt: 'desc' },
    });
    return row === null ? null : toRecord(row);
  }
}

function toRecord(row: {
  readonly processId: string;
  readonly processRole: string;
  readonly status: string;
  readonly pid: number | null;
  readonly startedAt: Date;
  readonly lastHeartbeatAt: Date;
  readonly stoppedAt: Date | null;
}): ProcessHeartbeatRecord {
  const status: ProcessHeartbeatStatus = row.status === 'STOPPED' ? 'STOPPED' : 'RUNNING';
  return {
    processId: row.processId,
    processRole: row.processRole,
    status,
    ...(row.pid === null ? {} : { pid: row.pid }),
    startedAt: row.startedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    ...(row.stoppedAt === null ? {} : { stoppedAt: row.stoppedAt }),
  };
}
