export type ProcessHeartbeatStatus = 'RUNNING' | 'STOPPED';

export interface ProcessHeartbeatRecord {
  readonly processId: string;
  readonly processRole: string;
  readonly status: ProcessHeartbeatStatus;
  readonly pid?: number;
  readonly startedAt: Date;
  readonly lastHeartbeatAt: Date;
  readonly stoppedAt?: Date;
}

export interface UpsertProcessHeartbeatInput {
  readonly processId: string;
  readonly processRole: string;
  readonly pid?: number;
  readonly startedAt: Date;
  readonly heartbeatAt: Date;
}

export interface IProcessHeartbeatRepository {
  upsert(input: UpsertProcessHeartbeatInput): Promise<void>;
  markStopped(processId: string, stoppedAt: Date): Promise<boolean>;
  findById(processId: string): Promise<ProcessHeartbeatRecord | null>;
}
