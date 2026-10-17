import { expect, test } from 'vitest';
import { join } from 'node:path';
import { PiProcess } from '../../src/pi.js';
import { ROOT } from '../../src/config.js';

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
