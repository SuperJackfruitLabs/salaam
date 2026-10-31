import { expect, test } from 'vitest';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { taskFixture } from '../task-helpers.js';
import { until } from '../helpers.js';
import { ROOT } from '../../src/config.js';
import { PtyClient } from '../terminal-helpers.js';

test('real TUI creates and triggers a one-shot job; hard terminal loss and observer reconnect preserve its running occurrence', async () => {
  const f = await taskFixture({ extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') });
  let first: PtyClient | undefined, observer: PtyClient | undefined;
  try {
    await f.plan();
    first = new PtyClient(
      [
        join(ROOT, 'bin/salaam.mjs'),
        'tui',
        '--session',
        f.session.id,
        '--state',
        f.state,
        '--takeover',
      ],
      { state: f.state, columns: 120, rows: 48 },
    );
    await first.contains('You have control');
    const palette = async (terminal: PtyClient, item: string) => {
      await terminal.write('\x0b');
      await terminal.contains('Salaam · actions');
      await terminal.write(item + '\r');
    };
    await palette(first, 'Job actions');
    await first.contains('Create one-shot job · JSON');
    await first.write('\x15');
    await first.write(JSON.stringify({ name: 'Terminal job proof', max_steps: 1, compact: false }));
    await first.write('\r');
    const job = await until(() => f.service.jobs.forSession(f.session.id), Boolean);
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(0);
    await first.contains('TASK · ACCEPTED');
    await palette(first, 'Job actions');
    await first.contains('Salaam · one-shot job');
    await first.write('Trigger one-shot job\r');
    await first.contains('One-shot occurrence key');
    await first.write('\x15');
    await first.write('tui-proof-occurrence');
    await first.write('\r');
    await until(() => existsSync(join(f.source, 'probe-entered')), Boolean);
    const before = f.service.jobs.view(job!.id),
      attempt = f.service.store.snapshot(f.session.id).attempts[0]!;
    expect(before.occurrence?.occurrence_key).toBe('tui-proof-occurrence');
    await first.command({ op: 'signal', signal: 'SIGKILL' });
    await first.exit();
    first = undefined;
    expect(f.service.store.attempt(attempt.id).state).toBe('running');
    observer = new PtyClient(
      [
        join(ROOT, 'bin/salaam.mjs'),
        'tui',
        '--session',
        f.session.id,
        '--state',
        f.state,
        '--observe',
      ],
      { state: f.state, columns: 120, rows: 48 },
    );
    await observer.contains('Observer');
    writeFileSync(join(f.source, 'release-probe'), 'continue');
    await until(
      () => f.service.jobs.view(job!.id),
      (j) => j.state === 'succeeded',
      15000,
    );
    await palette(observer, 'Session context');
    await until(
      () => observer!.screen(),
      (screen) => screen.includes('SESSION CONTEXT') || screen.includes('TASK FACTS'),
    );
    await observer.write('\x1b[1;5H');
    await observer.contains('ONE-SHOT JOB · SUCCEEDED');
    if (process.env.SALAAM_JOB_CAPTURE_DIR)
      await observer.capture(join(process.env.SALAAM_JOB_CAPTURE_DIR, 'job-completed.svg'));
    expect(f.service.jobs.view(job!.id).occurrence?.id).toBe(before.occurrence?.id);
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(1);
    await observer.leave();
    expect((await observer.exit()).restored).toBe(true);
    observer = undefined;
  } finally {
    await first?.close();
    await observer?.close();
    await f.close();
  }
}, 30000);

test('real TUI captures and triggers a recurring template with a fresh session and shared result inbox', async () => {
  const f = await taskFixture();
  let terminal: PtyClient | undefined;
  try {
    await f.plan();
    terminal = new PtyClient(
      [
        join(ROOT, 'bin/salaam.mjs'),
        'tui',
        '--session',
        f.session.id,
        '--state',
        f.state,
        '--takeover',
      ],
      { state: f.state, columns: 120, rows: 48 },
    );
    await terminal.contains('You have control');
    const palette = async () => {
      await terminal!.write('\x0b');
      await terminal!.contains('Salaam · actions');
      await terminal!.write('Recurring jobs and schedules\r');
      await terminal!.contains('Salaam · recurring jobs');
    };
    await palette();
    await terminal.write('Capture a recurring template\r');
    await terminal.contains('Recurring template · JSON');
    await terminal.write('\x15');
    await terminal.write(
      JSON.stringify({
        name: 'Terminal recurring proof',
        max_steps: 1,
        compact: false,
        schedule: null,
      }),
    );
    await terminal.write('\r');
    const job = await until(() => f.service.recurring.list().jobs[0], Boolean);
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(0);
    await palette();
    await terminal.write('Terminal recurring proof\r');
    await terminal.contains('Recurring · Terminal recurring proof');
    await terminal.write('Trigger an occurrence\r');
    await terminal.contains('Occurrence key');
    await terminal.write('\x15');
    await terminal.write('terminal-recurring');
    await terminal.write('\r');
    const occurrence = await until(
      () => f.service.recurring.occurrences(job!.id).occurrences[0],
      (r) => !!r?.job_run_id,
    );
    await until(
      () => f.service.jobs.get(occurrence!.job_run_id!),
      (j) => j.state === 'succeeded',
      15000,
    );
    expect(occurrence!.session_id).not.toBe(f.session.id);
    await until(
      () => f.service.inbox.list().items,
      (items) => items.some((i) => i.kind === 'result'),
    );
    await terminal.write('\x0b');
    await terminal.contains('Salaam · actions');
    await terminal.write('Operator inbox\r');
    await terminal.contains('Salaam · operator inbox');
    await terminal.contains('result');
    if (process.env.SALAAM_JOB_CAPTURE_DIR)
      await terminal.capture(join(process.env.SALAAM_JOB_CAPTURE_DIR, 'recurring-inbox.svg'));
    await terminal.write('\x1b');
    await until(
      () => terminal!.screen(),
      (screen) => !screen.includes('Salaam · operator inbox'),
    );
    await terminal.leave();
    expect((await terminal.exit()).restored).toBe(true);
    terminal = undefined;
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);
