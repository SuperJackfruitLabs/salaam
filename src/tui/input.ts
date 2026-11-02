import { emitKeypressEvents } from 'node:readline';
import type { ReadStream } from 'node:tty';
import type { Writable } from 'node:stream';

/** Enter alone submits. Unicode line/paragraph separators remain prompt text. */
export function terminalInput(
  input: ReadStream,
  output: Writable,
  onLine: (line: string) => void,
  onClose: () => void,
): { close(): void; print(text: string): void } {
  let characters: string[] = [];
  let cursor = 0;
  let closed = false;
  const wasRaw = input.isRaw;
  const history: string[] = [];
  let historyIndex = 0;
  const width = (text: string) =>
    Array.from(text).reduce(
      (n, c) =>
        n +
        (/\p{Mark}/u.test(c)
          ? 0
          : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]|\p{Extended_Pictographic}/u.test(
                c,
              )
            ? 2
            : 1),
      0,
    );
  const render = () => {
    if (closed) return;
    output.write('\r\x1b[2K> ' + characters.join(''));
    const tail = width(characters.slice(cursor).join(''));
    if (tail) output.write(`\x1b[${tail}D`);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    input.off('keypress', keypress);
    input.off('end', close);
    input.setRawMode(wasRaw);
    input.pause();
    output.write('\r\x1b[2K');
    onClose();
  };
  const keypress = (
    value: string | undefined,
    key: { name?: string; ctrl?: boolean; meta?: boolean },
  ) => {
    if (key.ctrl && ['c', 'd'].includes(key.name ?? '')) {
      close();
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const text = characters.join('');
      characters = [];
      cursor = 0;
      if (text) {
        history.push(text);
        historyIndex = history.length;
      }
      output.write('\r\n');
      onLine(text);
      render();
      return;
    }
    if (key.name === 'left') cursor = Math.max(0, cursor - 1);
    else if (key.name === 'right') cursor = Math.min(characters.length, cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) cursor = characters.length;
    else if (key.name === 'backspace') {
      if (cursor) characters.splice(--cursor, 1);
    } else if (key.name === 'delete') characters.splice(cursor, 1);
    else if (key.ctrl && key.name === 'u') {
      characters.splice(0, cursor);
      cursor = 0;
    } else if (key.ctrl && key.name === 'k') characters.splice(cursor);
    else if (key.name === 'up' || key.name === 'down') {
      historyIndex = Math.max(
        0,
        Math.min(history.length, historyIndex + (key.name === 'up' ? -1 : 1)),
      );
      characters = Array.from(history[historyIndex] ?? '');
      cursor = characters.length;
    } else if (value && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(value)) {
      const added = Array.from(value);
      characters.splice(cursor, 0, ...added);
      cursor += added.length;
    }
    render();
  };
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.on('keypress', keypress);
  input.once('end', close);
  input.resume();
  render();
  return {
    close,
    print(text: string) {
      output.write('\r\x1b[2K' + text + '\r\n');
      render();
    },
  };
}
