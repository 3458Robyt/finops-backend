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
    await this.prisma.$transaction((transaction) =>
      transaction.runtimeProcessHeartbeat.upsert({
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
      }),
    );
  }

  public async markStopped(processId: string, stoppedAt: Date): Promise<boolean> {
    const result = await this.prisma.$transaction((transaction) =>
      transaction.runtimeProcessHeartbeat.updateMany({
        where: { processId, status: 'RUNNING' },
        data: { status: 'STOPPED', stoppedAt, lastHeartbeatAt: stoppedAt },
      }),
    );
    return result.count === 1;
  }

  public async findById(processId: string): Promise<ProcessHeartbeatRecord | null> {
    const row = await this.prisma.$transaction((transaction) =>
      transaction.runtimeProcessHeartbeat.findUnique({ where: { processId } }),
    );
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
