import { test, expect } from 'vitest';
import {
  boundShellCommand,
  shellPassthrough,
  typedText,
} from '../../src/local/shell-passthrough.js';

// Live pass 2026-11-01: the conversation showed the whole fixed !command instruction as what you
// typed. It now shows `! git status --short`; the binding reads the same prompt back.
test('a !command prompt round-trips to its command and displays as you typed it', () => {
  const prompt = shellPassthrough('!git status --short')!;
  expect(boundShellCommand(prompt)).toBe('git status --short');
  expect(typedText(prompt)).toBe('! git status --short');
  expect(typedText('just words')).toBe('just words');
  expect(boundShellCommand(prompt + ' extra')).toBeUndefined();
  expect(shellPassthrough('!echo ```')).toBeUndefined();
});
