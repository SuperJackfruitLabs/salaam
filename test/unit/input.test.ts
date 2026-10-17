import { expect, test } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ReadStream } from 'node:tty';
import { terminalInput } from '../../src/input.js';

test('terminal submits on Enter, preserves Unicode separators and detaches without submitting partial text', () => {
  const input = new PassThrough() as unknown as ReadStream;
  const output = new PassThrough();
  output.resume();
  const raw: boolean[] = [];
  input.setRawMode = (value: boolean) => {
    raw.push(value);
    return input;
  };
  Object.defineProperty(input, 'isRaw', { value: false });
  const lines: string[] = [];
  let closed = 0;
  terminalInput(
    input,
    output,
    (line) => lines.push(line),
    () => closed++,
  );
  input.emit('data', Buffer.from('Salaam 🌍\u2028one\u2029prompt'));
  expect(lines).toHaveLength(0);
  input.emit('data', Buffer.from('\r'));
  expect(lines).toEqual(['Salaam 🌍\u2028one\u2029prompt']);
  input.emit('data', Buffer.from('partial\x03'));
  expect(closed).toBe(1);
  expect(lines).toHaveLength(1);
  expect(raw).toEqual([true, false]);
});
