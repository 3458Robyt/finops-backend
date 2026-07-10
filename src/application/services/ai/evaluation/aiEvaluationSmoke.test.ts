import { describe, expect, test } from 'vitest';
import { goldenScenarios } from './goldenScenarios.js';
import { runScenarioOffline } from './goldenScenarioRunner.js';

describe('offline AI evaluation smoke suite', () => {
  test('all golden scenarios keep their expected rubric outcome', () => {
    const results = goldenScenarios.map((scenario) => runScenarioOffline(scenario));
    const failures = results.filter((result) => !result.matchedExpectation);

    expect(failures).toEqual([]);
    expect(results.some((result) => result.outcome === 'PARSED_AND_PASSED')).toBe(true);
    expect(results.some((result) => result.outcome === 'PARSED_BUT_FAILED')).toBe(true);
    expect(results.some((result) => result.outcome === 'PARSE_REJECTED')).toBe(true);
  });
});
