import type { ProcessRole } from '../infrastructure/config/runtimeConfigTypes.js';

/** Builds the stable process key shared by heartbeat and readiness probes. */
export function createProcessIdentity(processRole: ProcessRole, hostname: string | undefined, pid: number): string {
  const normalizedHost = hostname?.trim();
  const instance = (normalizedHost === undefined || normalizedHost === '' ? 'local' : normalizedHost)
    .replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return `finops:${processRole}:${instance}:${pid}`;
}
