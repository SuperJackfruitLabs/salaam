import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SalaamApp } from '../../src/tui.js';
import { ChoiceModal } from '../../src/tui-modals.js';
import type { SessionSnapshot } from '../../src/protocol.js';

function app(snapshot?: Partial<SessionSnapshot>) {
  const a = new SalaamApp({ state: '/tmp/salaam-composer-keys' });
  let exits = 0;
  a['finish'] = () => void exits++;
  if (snapshot)
    a.client.snapshot = {
      id: 's1',
      submissions: [],
      attempts: [],
      approvals: [],
      capabilities: [],
      ...snapshot,
    } as unknown as SessionSnapshot;
  return { a, exits: () => exits };
}
const coding = { capabilities: ['local-coding-reviewed'] };
const settle = () => new Promise((r) => setTimeout(r, 0));

test('ctrl+c on an empty composer arms; a second press leaves', () => {
  const { a, exits } = app();
  a['input']('\x03');
  expect(exits()).toBe(0);
  expect(a.client.notice).toContain('ctrl+c again to leave');
  a['input']('\x03');
  expect(exits()).toBe(1);
});

test('any other key disarms ctrl+c', () => {
  const { a, exits } = app();
  a['input']('\x03');
  a['input']('x');
  a.editor.setText('');
  a['input']('\x03');
  expect(exits()).toBe(0);
});

test('ctrl+c clears typed text instead of leaving', () => {
  const { a, exits } = app();
  a.editor.setText('half a thought');
  a['input']('\x03');
  expect(a.editor.getExpandedText()).toBe('');
  expect(exits()).toBe(0);
});

test('ctrl+c stops a running coding turn', async () => {
  const { a, exits } = app({ ...coding, attempts: [{ id: 'att', state: 'running' }] as never });
  const cancelled: string[] = [];
  a.client.cancel = async (id: string) => void cancelled.push(id);
  a['input']('\x03');
  await settle();
  expect(cancelled).toEqual(['att']);
  expect(exits()).toBe(0);
});

test('ctrl+c never cancels strict work: it arms like an idle composer', async () => {
  const { a, exits } = app({ attempts: [{ id: 'att', state: 'running' }] as never });
  const cancelled: string[] = [];
  a.client.cancel = async (id: string) => void cancelled.push(id);
  a['input']('\x03');
  await settle();
  expect(cancelled).toEqual([]);
  expect(exits()).toBe(0);
});

test('ctrl+k kills to end of line when there is text, and opens actions when empty', () => {
  const { a } = app();
  a.editor.setText('keep this|drop this');
  a.editor.handleInput('\x01');
  for (let i = 0; i < 'keep this'.length; i++) a.editor.handleInput('\x1b[C');
  // The app lets ctrl+k through to the editor while there is text.
  expect(a['input']('\x0b')).toBeUndefined();
  a.editor.handleInput('\x0b');
  expect(a.editor.getExpandedText()).toBe('keep this');
  expect(a.tui.getFocusedComponent()).toBe(a.editor);
  a.editor.setText('');
  a['input']('\x0b');
  expect(a.tui.getFocusedComponent()).toBeInstanceOf(ChoiceModal);
  a['closeModal']();
});

test('ctrl+r searches sent messages; enter keeps the match, esc restores the draft', () => {
  const { a } = app();
  a['sent'].entries = ['run npm test', 'fix lint', 'run go test'];
  a.editor.setText('draft');
  a['input']('\x12');
  for (const ch of 'test') a['input'](ch);
  expect(a.editor.getExpandedText()).toBe('run go test');
  a['input']('\x12');
  expect(a.editor.getExpandedText()).toBe('run npm test');
  expect(a.client.notice).toContain("reverse-i-search)`test'");
  a['input']('\r');
  expect(a.editor.getExpandedText()).toBe('run npm test');
  expect(a['search']).toBeUndefined();

  a.editor.setText('draft');
  a['input']('\x12');
  for (const ch of 'lint') a['input'](ch);
  expect(a.editor.getExpandedText()).toBe('fix lint');
  a['input']('\x1b');
  expect(a.editor.getExpandedText()).toBe('draft');
});

test('moved keys: ctrl+g opens the editor, alt+g reviews changes, f5 refreshes, f2 opens actions', async () => {
  const { a } = app();
  let edited = 0,
    refreshed = 0;
  a['editPrompt'] = async () => void edited++;
  a['refresh'] = async () => void refreshed++;
  a['input']('\x07');
  await settle();
  a['input']('\x1b[15~');
  await settle();
  expect(edited).toBe(1);
  expect(refreshed).toBe(1);
  a['input']('\x1bOQ');
  expect(a.tui.getFocusedComponent()).toBeInstanceOf(ChoiceModal);
  a['closeModal']();
  a['input']('\x1bg');
  expect(a.view.tab).toBe('changes');
});

test('!command sends an exact-run instruction in a coding session and records what was typed', async () => {
  const { a } = app(coding);
  const sent: string[] = [];
  a.client.submit = async (text: string) => (sent.push(text), 'sub');
  a.editor.setText('!npm test');
  await a['submit']();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('salaam_local');
  expect(sent[0]).toContain('```sh\nnpm test\n```');
  expect(a['sent'].entries.at(-1)).toBe('!npm test');
});

test('!command is refused outside a local coding session and nothing is sent', async () => {
  const { a } = app({});
  const sent: string[] = [];
  a.client.submit = async (text: string) => (sent.push(text), 'sub');
  a.editor.setText('!rm -rf build');
  await expect(a['submit']()).rejects.toThrow(/local coding sessions/);
  expect(sent).toEqual([]);
});

test('large pastes collapse to a marker and expand in full on submit', () => {
  const { a } = app();
  const body = Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n');
  a.editor.handleInput('\x1b[200~' + body + '\x1b[201~');
  expect(a.editor.getText()).toMatch(/^\[paste #1 \+40 lines\]$/);
  expect(a.editor.getExpandedText()).toBe(body);
});

test('ctrl+g editor: private temp file, edited text comes back, file removed after', async () => {
  const { a } = app();
  const dir = mkdtempSync(join(tmpdir(), 'salaam-ed-'));
  const out = join(dir, 'seen'),
    script = join(dir, 'editor.cjs');
  writeFileSync(
    script,
    "const fs=require('fs'),f=process.argv[2];" +
      `fs.writeFileSync(${JSON.stringify(out)},(fs.statSync(f).mode&0o777).toString(8)+' '+f);` +
      "fs.writeFileSync(f,'edited text')",
  );
  const saved = process.env.VISUAL;
  process.env.VISUAL = `'${process.execPath}' '${script}'`;
  try {
    a.editor.setText('draft');
    await a['editPrompt']();
  } finally {
    if (saved === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = saved;
  }
  const [mode, path] = readFileSync(out, 'utf8').split(' ');
  expect(mode).toBe('600');
  expect(existsSync(path!)).toBe(false);
  expect(a.editor.getExpandedText()).toBe('edited text');
});
