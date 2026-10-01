import { describe, expect, it } from 'vitest';
import { assessFocusSchemaHeader, FOCUS_1_0_MANDATORY_COLUMNS } from './focusSchemaValidation.js';

describe('FOCUS header validation', () => {
  it('accepts a complete FOCUS 1.0 mandatory header', () => {
    expect(assessFocusSchemaHeader('1.0', FOCUS_1_0_MANDATORY_COLUMNS)).toEqual({
      status: 'CONFORMANT',
      missingMandatoryColumns: [],
    });
  });

  it('reports missing columns separately from null row values', () => {
    const headers = FOCUS_1_0_MANDATORY_COLUMNS.filter(
      (column) => column !== 'ChargeClass' && column !== 'ContractedCost',
    );

    expect(assessFocusSchemaHeader('1.0', headers)).toEqual({
      status: 'NONCONFORMANT',
      missingMandatoryColumns: ['ChargeClass', 'ContractedCost'],
    });
  });

  it('does not certify a version without a defined schema rule', () => {
    expect(assessFocusSchemaHeader('1.2', FOCUS_1_0_MANDATORY_COLUMNS)).toEqual({
      status: 'UNVERIFIED',
      missingMandatoryColumns: [],
    });
  });
});
