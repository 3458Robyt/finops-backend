import { describe, expect, it, vi } from 'vitest';
import type { CloudConnectionController } from '../controllers/CloudConnectionController.js';
import { createCloudConnectionRoutes } from './cloudConnectionRoutes.js';

describe('createCloudConnectionRoutes', () => {
  it('requires manager authorization for every onboarding mutation', () => {
    const controller = Object.fromEntries([
      'listProviders', 'listConnections', 'createConnection', 'getOnboardingDetail',
      'updateConnection',
      'storeCredential', 'revokeCredential', 'validateConnection', 'activateConnection', 'setConnectionStatus',
      'queueIngestion', 'configureBillingSource', 'getHealth',
      'retryFailedIngestionJobs', 'cancelPendingIngestionJobs',
      'configureMetricDefinitions',
      'previewFocusSource',
    ].map((name) => [name, vi.fn()])) as unknown as CloudConnectionController;
    const auth = vi.fn((_req, _res, next: () => void) => next());
    const manager = vi.fn((_req, _res, next: () => void) => next());
    const router = createCloudConnectionRoutes(controller, auth, manager);
    const routes = router.stack.flatMap((layer) => layer.route === undefined ? [] : [layer.route]);

    for (const [method, path] of [
      ['post', '/'],
      ['patch', '/:id'],
      ['post', '/:id/credentials'],
      ['patch', '/:id/status'],
      ['delete', '/:id/credentials/:credentialId'],
      ['post', '/:id/validate'],
      ['post', '/:id/focus-preview'],
      ['post', '/:id/activate'],
      ['post', '/:id/ingestion-jobs'],
      ['post', '/:id/ingestion-jobs/retry-failed'],
      ['post', '/:id/ingestion-jobs/cancel-pending'],
      ['put', '/:id/billing-source'],
      ['put', '/:id/metric-definitions'],
    ] as const) {
      const route = routes.find((item) => item.path === path && item.methods[method]);
      expect(route, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(route?.stack.map((layer) => layer.handle)).toContain(manager);
    }

    for (const path of ['/providers', '/', '/:id/onboarding', '/:id/ingestion-health']) {
      const route = routes.find((item) => item.path === path && item.methods['get']);
      expect(route?.stack.map((layer) => layer.handle)).not.toContain(manager);
    }
  });
});
