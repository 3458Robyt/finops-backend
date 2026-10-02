import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { describe, expect, test, vi } from 'vitest';
import type { CloudConnectionService } from '../../application/services/CloudConnectionService.js';
import type { PreviewMetricDefinitionsInput } from '../../application/services/cloud-connections/CloudConnectionContracts.js';
import { CloudConnectionManagementController } from './CloudConnectionManagementController.js';

describe('CloudConnectionManagementController metric discovery cancellation', () => {
  test('aborts the service when the client closes the response and does not write to the closed socket', async () => {
    let receivedSignal: AbortSignal | undefined;
    const service = {
      previewMetricDefinitions: vi.fn((input: PreviewMetricDefinitionsInput) => {
        receivedSignal = input.signal;
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        });
      }),
    } as unknown as CloudConnectionService;
    const controller = new CloudConnectionManagementController(service);
    const req = {
      auth: { tenantId: 'tenant-1', userId: 'user-1' },
      params: { id: 'connection-1' },
      body: { scope: { regionId: 'us-phoenix-1', compartmentId: 'compartment-1' } },
    } as unknown as Request;
    const res = makeResponse();

    const handling = controller.previewMetricDefinitions(req, res);
    res.destroyed = true;
    res.emit('close');
    await handling;

    expect(receivedSignal?.aborted).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

function makeResponse(): Response & EventEmitter & { destroyed: boolean } {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    status: vi.fn(),
    json: vi.fn(),
  });
  response.status.mockReturnValue(response);
  response.json.mockImplementation(() => {
    response.writableEnded = true;
    return response;
  });
  return response as unknown as Response & EventEmitter & { destroyed: boolean };
}
