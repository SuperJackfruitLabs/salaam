import { expect, test } from 'vitest';
import { definiteHelperRefusal } from '../../src/station-work.js';

// Fix 2: the helper refuses a request it cannot decode before it executes anything
// (station_request_invalid, written as exactly {version, ok, code}). That changed nothing, so the
// write is failed_definite, not outcome_unknown. Nothing else about the refusal is loosened.
test('a pre-execution request refusal is definite; its exact shape is required', () => {
  const invalid = { version: 1, ok: false, code: 'station_request_invalid' };
  expect(definiteHelperRefusal(1, false, invalid)).toBe('station_request_invalid');
  for (const [why, args] of Object.entries({
    'transport failed': [1, true, invalid],
    'other exit code': [2, false, invalid],
    'claims ok': [1, false, { ...invalid, ok: true }],
    'other version': [1, false, { ...invalid, version: 2 }],
    'an effect state (it executed)': [1, false, { ...invalid, effect_state: 'unknown' }],
    'extra fields': [1, false, { ...invalid, detail: 'x' }],
    'another code': [1, false, { ...invalid, code: 'station_files_unavailable' }],
  }) as [string, [number, boolean, Record<string, unknown>]][])
    expect(definiteHelperRefusal(...args), why).toBeNull();
});

test('the existing not-started refusal stays definite, and an unknown effect stays unknown', () => {
  const unavailable = { version: 1, ok: false, code: 'station_files_unavailable' };
  expect(definiteHelperRefusal(1, false, { ...unavailable, effect_state: 'not_started' })).toBe(
    'station_files_changed',
  );
  expect(definiteHelperRefusal(1, false, { ...unavailable, effect_state: 'unknown' })).toBeNull();
});
