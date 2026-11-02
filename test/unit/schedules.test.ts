import { expect, test } from 'vitest';
import { adjacent, dueSlots, schedule } from '../../src/tasks/schedules.js';
const daily = (time: string, fold = 'first') =>
  schedule({
    kind: 'daily',
    time,
    timezone: 'America/New_York',
    gap: 'skip',
    fold,
    missed: 'catch_up',
    max_catch_up: 2,
  });
test('daily schedules skip nonexistent local times and choose exactly the reviewed DST fold', () => {
  expect(new Date(adjacent(daily('02:30'), Date.parse('2026-03-08T00:00:00Z'))).toISOString()).toBe(
    '2026-03-09T06:30:00.000Z',
  );
  expect(new Date(adjacent(daily('01:30'), Date.parse('2026-11-01T00:00:00Z'))).toISOString()).toBe(
    '2026-11-01T05:30:00.000Z',
  );
  expect(
    new Date(adjacent(daily('01:30', 'second'), Date.parse('2026-11-01T00:00:00Z'))).toISOString(),
  ).toBe('2026-11-01T06:30:00.000Z');
  expect(new Date(adjacent(daily('01:30'), Date.parse('2026-11-01T05:30:00Z'))).toISOString()).toBe(
    '2026-11-02T06:30:00.000Z',
  );
});
test('half-hour zones and long downtime have bounded catch-up and explicit skip', () => {
  const india = schedule({
    kind: 'daily',
    time: '09:00',
    timezone: 'Asia/Kolkata',
    gap: 'skip',
    fold: 'first',
    missed: 'skip',
    max_catch_up: 1,
  });
  expect(new Date(adjacent(india, Date.parse('2026-10-18T00:00:00Z'))).toISOString()).toBe(
    '2026-10-18T03:30:00.000Z',
  );
  const s = schedule({
    kind: 'interval',
    anchor: 0,
    every_ms: 1000,
    missed: 'catch_up',
    max_catch_up: 2,
  });
  expect(adjacent(schedule({ ...s, anchor: 100000 }), 0)).toBe(100000);
  expect(dueSlots(s, 1000, 100000000)).toEqual({
    slots: [1000, 2000],
    next: 100001000,
    skipped: true,
  });
  expect(dueSlots({ ...s, missed: 'skip' }, 1000, 100000000)).toEqual({
    slots: [],
    next: 100001000,
    skipped: true,
  });
  expect(() => schedule({ ...s, every_ms: 0 })).toThrow();
  expect(() => schedule({ ...india, timezone: 'fake/zone' })).toThrow();
});
