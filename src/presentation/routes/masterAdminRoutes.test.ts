import { describe, expect, it, vi } from 'vitest';
import { createMasterAdminRoutes } from './masterAdminRoutes.js';

describe('createMasterAdminRoutes', () => {
  it('registers the audited single-job reprocess action', () => {
    const masterAdmin = {
      listTenants: vi.fn(), createTenant: vi.fn(), updateTenant: vi.fn(), listUsers: vi.fn(), createUser: vi.fn(),
      listAssignments: vi.fn(), assignTenant: vi.fn(), revokeTenant: vi.fn(),
    };
    const ingestion = {
      list: vi.fn(), reconcile: vi.fn(), deletePending: vi.fn(), cancel: vi.fn(), reprocess: vi.fn(), archive: vi.fn(),
    };
    const allow = (_req: unknown, _res: unknown, next: () => void) => next();
    const router = createMasterAdminRoutes(masterAdmin as never, ingestion as never, allow as never);
    const stack = router.stack as readonly { readonly route?: { readonly path: string; readonly methods: Record<string, boolean>; readonly stack: readonly { readonly handle: unknown }[] } }[];
    const route = stack.find((layer) => layer.route?.path === '/ingestion-jobs/:jobId/reprocess' && layer.route.methods['post']);

    expect(route?.route?.stack.at(-1)?.handle).toBe(ingestion.reprocess);
  });
});
