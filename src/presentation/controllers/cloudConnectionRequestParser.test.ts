import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { CloudConnectionRequestParser } from './cloudConnectionRequestParser.js';

describe('CloudConnectionRequestParser', () => {
  const parser = new CloudConnectionRequestParser();

  it('normalizes authenticated tenant and route parameters', () => {
    const request = {
      auth: { tenantId: ' tenant-1 ', userId: 'user-1' },
      params: { id: ' connection-1 ' },
    } as unknown as Request;

    expect(parser.requireTenant(request)).toBe(' tenant-1 ');
    expect(parser.requireParam(request, 'id')).toBe('connection-1');
  });

  it('rejects unauthenticated or malformed request boundaries', () => {
    expect(() => parser.requireTenant({ params: {} } as unknown as Request)).toThrowError(
      'Debes iniciar sesión para continuar.',
    );
    expect(() => parser.requireObjectBody([])).toThrowError('El cuerpo de la solicitud debe ser un objeto JSON.');
    expect(() => parser.requireString(' ', 'name')).toThrowError('El campo name es obligatorio.');
    expect(() => parser.parseDate('not-a-date', 'targetStart')).toThrowError('targetStart must be an ISO date');
  });

  it('accepts the supported source, credential and billing modes only', () => {
    expect(parser.parseSourceType('INVENTORY')).toBe('INVENTORY');
    expect(parser.parseCredentialPurpose('METRICS_READ')).toBe('METRICS_READ');
    expect(parser.parseFocusSourceMode('object')).toBe('object');
    expect(parser.parseBillingSourceMode('AUTO')).toBe('AUTO');

    expect(() => parser.parseSourceType('UNKNOWN')).toThrow();
    expect(() => parser.parseCredentialPurpose('WRITE')).toThrow();
    expect(() => parser.parseFocusSourceMode('bucket')).toThrow();
    expect(() => parser.parseBillingSourceMode('MANUAL')).toThrow();
  });

  it('parses optional numeric query/body values without accepting invalid numbers', () => {
    expect(parser.parseLimit(['25'])).toBe(25);
    expect(parser.parseLimit(undefined)).toBeUndefined();
    expect(parser.parseOptionalNumber('12', 'lookbackDays')).toBe(12);
    expect(parser.parseOptionalNumber('', 'lookbackDays')).toBeUndefined();
    expect(() => parser.parseOptionalNumber('abc', 'lookbackDays')).toThrowError(
      'lookbackDays must be a number',
    );
  });
});
