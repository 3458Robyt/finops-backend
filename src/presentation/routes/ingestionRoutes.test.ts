import { describe, expect, it, vi } from 'vitest';
import type { CloudConnectionController } from '../controllers/CloudConnectionController.js';
import { createIngestionRoutes } from './ingestionRoutes.js';

describe('createIngestionRoutes', () => {
  it('registers tenant-level job creation under POST /jobs', () => {
    const controller = {
      queueTenantIngestion: vi.fn(),
      listIngestionHistory: vi.fn(),
      listDataQuality: vi.fn(),
    } as unknown as CloudConnectionController;
    const router = createIngestionRoutes(controller, (_req, _res, next) => next());
    const stack = router.stack as readonly {
      readonly route?: {
        readonly path: string;
        readonly methods: Record<string, boolean>;
        readonly stack: readonly { readonly handle: unknown }[];
      };
    }[];

    const postJobs = stack.find((layer) => layer.route?.path === '/jobs' && layer.route.methods['post']);

    expect(postJobs).toBeDefined();
    expect(postJobs?.route?.stack.at(-1)?.handle).toBe(controller.queueTenantIngestion);
  });
});
