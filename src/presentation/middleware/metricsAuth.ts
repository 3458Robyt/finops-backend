import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export function createMetricsAuth(
  expectedToken?: string,
  isProduction = false,
): RequestHandler {
  return (req, res, next): void => {
    const expected = expectedToken?.trim();
    if (expected === undefined || expected === '') {
      if (isProduction) {
        res.status(503).json({ success: false, error: 'Las métricas no están configuradas.', code: 'METRICS_NOT_CONFIGURED' });
        return;
      }
      next();
      return;
    }

    const received = req.header('x-metrics-token') ?? '';
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const receivedBuffer = Buffer.from(received, 'utf8');
    if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
      res.status(401).json({ success: false, error: 'Token de métricas inválido.', code: 'METRICS_UNAUTHORIZED' });
      return;
    }
    next();
  };
}
