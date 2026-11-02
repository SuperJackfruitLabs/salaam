import { ProcessTerminal } from '@earendil-works/pi-tui';

/** Frames are atomic. A slow terminal gets one fresh full redraw after drain. */
export class SalaamTerminal extends ProcessTerminal {
  private waiting = false;
  private skipped = false;
  onDrain?: () => void;
  override get columns(): number {
    return Math.min(300, super.columns);
  }
  override get rows(): number {
    return Math.min(100, super.rows);
  }
  override write(data: string): void {
    const frame = data.startsWith('\x1b[?2026h') && !data.includes('\x1b[?1049');
    if (frame && process.stdout.writableLength > 256 * 1024) {
      this.skipped = true;
      this.drain();
      return;
    }
    super.write(data);
    if (process.stdout.writableNeedDrain) this.drain();
  }
  private drain(): void {
    if (this.waiting) return;
    this.waiting = true;
    process.stdout.once('drain', () => {
      this.waiting = false;
      if (this.skipped) {
        this.skipped = false;
        this.onDrain?.();
      }
    });
  }
}
/** Quoted editor arguments only; expansion and shell evaluation are deliberately absent. */
export function editorArguments(value: string): string[] {
  const parts: string[] = [];
  let current = '',
    quote = '',
    escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") escaped = true;
    else if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else current += char;
  }
  if (escaped || quote) throw new Error('Close the quotes in VISUAL or EDITOR.');
  if (current) parts.push(current);
  if (!parts.length) throw new Error('Set VISUAL or EDITOR to an editor executable.');
  return parts;
}
