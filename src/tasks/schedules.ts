import { object, ServiceError } from '../core/index.js';

export type Schedule = (
  | { kind: 'interval'; anchor: number; every_ms: number }
  | { kind: 'daily'; time: string; timezone: string; gap: 'skip'; fold: 'first' | 'second' }
) & { missed: 'skip' | 'catch_up'; max_catch_up: number };
export function schedule(input: unknown): Schedule {
  const s = object(input);
  const allowed = [
    'kind',
    'anchor',
    'every_ms',
    'time',
    'timezone',
    'gap',
    'fold',
    'missed',
    'max_catch_up',
  ];
  if (
    Object.keys(s).some((k) => !allowed.includes(k)) ||
    !['skip', 'catch_up'].includes(String(s.missed)) ||
    !Number.isSafeInteger(s.max_catch_up) ||
    Number(s.max_catch_up) < 1 ||
    Number(s.max_catch_up) > 8
  )
    throw new ServiceError(
      'invalid_schedule',
      'Declare missed skip/catch_up and max_catch_up 1–8',
      400,
    );
  if (
    s.kind === 'interval' &&
    Number.isSafeInteger(s.anchor) &&
    Number(s.anchor) >= 0 &&
    Number.isSafeInteger(s.every_ms) &&
    Number(s.every_ms) >= 1000 &&
    Number(s.every_ms) <= 366 * 86400000
  )
    return {
      kind: 'interval',
      anchor: Number(s.anchor),
      every_ms: Number(s.every_ms),
      missed: s.missed as Schedule['missed'],
      max_catch_up: Number(s.max_catch_up),
    };
  if (
    s.kind === 'daily' &&
    typeof s.time === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) &&
    typeof s.timezone === 'string' &&
    s.gap === 'skip' &&
    ['first', 'second'].includes(String(s.fold))
  ) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: s.timezone }).format(0);
    } catch {
      throw new ServiceError('invalid_schedule', 'Use an IANA timezone', 400);
    }
    return {
      kind: 'daily',
      time: s.time,
      timezone: s.timezone,
      gap: 'skip',
      fold: s.fold as 'first' | 'second',
      missed: s.missed as Schedule['missed'],
      max_catch_up: Number(s.max_catch_up),
    };
  }
  throw new ServiceError(
    'invalid_schedule',
    'Use a bounded UTC interval or daily IANA time with explicit gap/fold rules',
    400,
  );
}
function local(ms: number, timezone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms);
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((k) =>
    Number(parts.find((p) => p.type === k)!.value),
  );
}
/** Find an adjacent logical slot without scanning downtime or advancing a wall-clock cursor. */
export function adjacent(s: Schedule, after: number, direction: 1 | -1 = 1): number {
  if (s.kind === 'interval') {
    const index =
      direction === 1
        ? Math.floor((after - s.anchor) / s.every_ms) + 1
        : Math.ceil((after - s.anchor) / s.every_ms) - 1;
    return s.anchor + (direction === 1 ? Math.max(0, index) : index) * s.every_ms;
  }
  const [year, month, day] = local(after, s.timezone),
    [hour, minute] = s.time.split(':').map(Number);
  const base = Date.UTC(year!, month! - 1, day!);
  for (let d = 0; d < 5; d++) {
    const dayBase = base + d * direction * 86400000,
      naive = dayBase + hour! * 3600000 + minute! * 60000;
    const offsets = new Set<number>();
    for (let h = -36; h <= 36; h += 6) {
      const sample = naive + h * 3600000,
        p = local(sample, s.timezone);
      offsets.add(Date.UTC(p[0]!, p[1]! - 1, p[2]!, p[3]!, p[4]!, p[5]!) - sample);
    }
    const candidates = [...offsets]
      .map((offset) => naive - offset)
      .filter((ms) => {
        const p = local(ms, s.timezone);
        return Date.UTC(p[0]!, p[1]! - 1, p[2]!, p[3]!, p[4]!) === naive;
      })
      .sort((a, b) => a - b);
    const selected = s.fold === 'first' ? candidates[0] : candidates.at(-1);
    if (selected !== undefined && (direction === 1 ? selected > after : selected < after))
      return selected;
  }
  throw new ServiceError('schedule_unavailable', 'No daily slot within bounded calendar search');
}
export function dueSlots(
  s: Schedule,
  next: number,
  now: number,
): { slots: number[]; next: number; skipped: boolean } {
  if (now < next) return { slots: [], next, skipped: false };
  const latest = adjacent(s, now + 1, -1);
  if (s.missed === 'skip')
    return {
      slots: now - next < 1000 ? [next] : [],
      next: adjacent(s, now),
      skipped: now - next >= 1000,
    };
  const slots: number[] = [];
  let cursor = next;
  while (cursor <= now && slots.length < s.max_catch_up) {
    slots.push(cursor);
    cursor = adjacent(s, cursor);
  }
  return { slots, next: adjacent(s, now), skipped: cursor <= latest };
}
