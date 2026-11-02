import { expect, test } from 'vitest';
import { join } from 'node:path';
import { PiProcess } from '../../src/runtime/pi.js';
import { ROOT } from '../../src/core/config.js';

test('LF framing preserves Unicode separators and fragmented UTF-8; stderr stays separate', async () => {
  const pi = new PiProcess(
    process.execPath,
    [join(ROOT, 'test/fixtures/protocol-pi.mjs')],
    ROOT,
    {},
  );
  try {
    expect((await pi.command('get_state')).data).toEqual({ label: 'Salaam\u2028नमस्ते🌍' });
    expect(pi.diagnostics()).toContain('diagnostic text');
  } finally {
    await pi.stop();
  }
});
test.each(['invalid', 'oversize'])('rejects malformed or oversized stdout (%s)', async (fault) => {
  const pi = new PiProcess(process.execPath, [join(ROOT, 'test/fixtures/protocol-pi.mjs')], ROOT, {
    PROTOCOL_FAULT: fault,
  });
  try {
    await expect(pi.command('get_state')).rejects.toThrow(
      fault === 'invalid' ? 'Invalid Pi protocol' : 'exceeds 4 MiB',
    );
  } finally {
    await pi.stop();
  }
});

test('a finished tool step carries its text output, redacted and clipped, so a board can show it', async () => {
  const pi = new PiProcess(process.execPath, [join(ROOT, 'test/fixtures/protocol-pi.mjs')], ROOT, {
    PROTOCOL_TOOL_END: '1',
  });
  const seen: Array<Record<string, unknown>> = [];
  pi.on('activity', (o) => seen.push(o));
  try {
    await pi.command('get_state');
    expect(seen).toHaveLength(1);
    const o = seen[0]!;
    const output = String(o.output);
    expect(o.phase).toBe('finished');
    expect(output.startsWith('HTTP/1.1 403 Forbidden\nAuthorization: [redacted]')).toBe(true);
    expect(output).not.toContain('abc123secret');
    expect(output.length).toBeLessThanOrEqual(2048);
    expect(o.output_truncated).toBe(true);
  } finally {
    await pi.stop();
  }
});
