import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import xterm from '@xterm/headless';
import { ROOT } from '../src/core/config.js';
import { until } from './helpers.js';

export class PtyClient {
  readonly terminal: InstanceType<typeof xterm.Terminal>;
  readonly child: ReturnType<typeof spawn>;
  readonly ready: Promise<void>;
  private buffer = '';
  private writes = Promise.resolve();
  private sequence = 0;
  private pending = new Map<number, (value: any) => void>();
  readonly captured: Buffer[] = [];
  private captureBytes = 0;
  outputBytes = 0;
  pid = 0;
  result?: { code: number; restored: boolean };
  stderr = '';
  constructor(
    args: string[],
    options: {
      state: string;
      columns?: number;
      rows?: number;
      env?: NodeJS.ProcessEnv;
      executable?: string;
      cwd?: string;
    },
  ) {
    const columns = options.columns ?? 110,
      rows = options.rows ?? 36;
    this.terminal = new xterm.Terminal({
      cols: columns,
      rows,
      allowProposedApi: true,
      scrollback: 1000,
    });
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: options.state,
      TMPDIR: process.env.TMPDIR,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...options.env,
    };
    this.child = spawn(
      'python3',
      [
        join(ROOT, 'test/fixtures/terminal-driver.py'),
        JSON.stringify({
          argv: [options.executable ?? process.execPath, ...args],
          columns,
          rows,
          cwd: options.cwd ?? ROOT,
        }),
      ],
      { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let resolveReady!: () => void;
    this.ready = new Promise((resolve) => (resolveReady = resolve));
    this.child.stderr!.on(
      'data',
      (data) => (this.stderr = (this.stderr + data.toString()).slice(-8192)),
    );
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (data: string) => {
      this.buffer += data;
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'ready') {
          this.pid = event.pid;
          resolveReady();
        } else if (event.type === 'ack') {
          this.pending.get(event.id)?.(event);
          this.pending.delete(event.id);
        } else if (event.type === 'exit')
          this.result = { code: event.code, restored: event.restored };
        else if (event.type === 'data') {
          const bytes = Buffer.from(event.data, 'base64');
          this.outputBytes += bytes.length;
          if (this.captureBytes < 4 * 1024 * 1024) {
            this.captured.push(bytes);
            this.captureBytes += bytes.length;
          }
          this.writes = this.writes.then(
            () => new Promise<void>((resolve) => this.terminal.write(bytes, resolve)),
          );
        }
      }
    });
    this.child.on('error', (error) => {
      this.stderr += error.message;
      this.result = { code: -1, restored: false };
      resolveReady();
    });
    this.child.on('exit', (code) => {
      resolveReady();
      if (!this.result) this.result = { code: code ?? -1, restored: false };
    });
    this.terminal.onData((data) => {
      if (!this.result) void this.write(data).catch(() => {});
    });
  }
  async command(command: Record<string, unknown>): Promise<{ raw: boolean; restored: boolean }> {
    await this.ready;
    if (this.result) throw new Error('PTY driver exited: ' + this.stderr);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('PTY command timed out ' + JSON.stringify(command) + ' ' + this.stderr));
      }, 10000);
      this.pending.set(id, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
      this.child.stdin!.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }
  write(text: string | Buffer): Promise<{ raw: boolean; restored: boolean }> {
    return this.command({ op: 'write', data: Buffer.from(text).toString('base64') });
  }
  async resize(columns: number, rows: number): Promise<void> {
    this.terminal.resize(columns, rows);
    await this.command({ op: 'resize', columns, rows });
  }
  async screen(): Promise<string> {
    await this.writes;
    const buffer = this.terminal.buffer.active;
    return Array.from(
      { length: this.terminal.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '',
    ).join('\n');
  }
  async capture(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await this.writes;
    const escape = (value: string) =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    const color = (mode: number, value: number, fallback: string) => {
      if (mode === 0x3000000) return '#' + value.toString(16).padStart(6, '0');
      if (mode === 0x1000000 || mode === 0x2000000) {
        const ansi = [
          '#000000',
          '#cd0000',
          '#00cd00',
          '#cdcd00',
          '#0000ee',
          '#cd00cd',
          '#00cdcd',
          '#e5e5e5',
          '#7f7f7f',
          '#ff0000',
          '#00ff00',
          '#ffff00',
          '#5c5cff',
          '#ff00ff',
          '#00ffff',
          '#ffffff',
        ];
        if (value < 16) return ansi[value]!;
        if (value >= 232) {
          const shade = 8 + (value - 232) * 10;
          return `rgb(${shade},${shade},${shade})`;
        }
        const v = value - 16,
          levels = [0, 95, 135, 175, 215, 255];
        return `rgb(${levels[Math.floor(v / 36)]},${levels[Math.floor(v / 6) % 6]},${levels[v % 6]})`;
      }
      return fallback;
    };
    const cells: string[] = [];
    const buffer = this.terminal.buffer.active;
    for (let y = 0; y < this.terminal.rows; y++)
      for (let x = 0; x < this.terminal.cols; x++) {
        const cell = buffer.getLine(buffer.viewportY + y)?.getCell(x);
        if (!cell) continue;
        const bg = color(cell.getBgColorMode(), cell.getBgColor(), '#0c1618'),
          fg = color(cell.getFgColorMode(), cell.getFgColor(), '#e5eee9');
        cells.push(`<rect x="${x * 9}" y="${y * 19}" width="9" height="19" fill="${bg}"/>`);
        if (cell.getWidth() && cell.getChars())
          cells.push(
            `<text x="${x * 9}" y="${y * 19 + 14}" fill="${fg}"${cell.isBold() ? ' font-weight="bold"' : ''}>${escape(cell.getChars())}</text>`,
          );
      }
    writeFileSync(
      path,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${this.terminal.cols * 9}" height="${this.terminal.rows * 19}"><g font-family="Menlo,monospace" font-size="14" xml:space="preserve">${cells.join('')}</g></svg>`,
    );
    writeFileSync(path.replace(/\.svg$/, '.txt'), await this.screen());
  }
  async contains(text: string, timeout = 10000): Promise<string> {
    return until(
      () => this.screen(),
      (screen) => screen.includes(text),
      timeout,
    );
  }
  /** Ctrl+C until the TUI leaves: a press clears typed text, and leaving takes a second press
   * (trial polish, 2026-10-31). */
  async leave(): Promise<void> {
    for (let i = 0; i < 3 && !this.result; i++) {
      await this.write('\x03').catch(() => {});
      await until(() => this.result, Boolean, 400).catch(() => {});
    }
  }
  async exit(): Promise<{ code: number; restored: boolean }> {
    await until(() => this.result, Boolean);
    await this.writes;
    return this.result!;
  }
  async close(): Promise<void> {
    if (!this.result) {
      await this.command({ op: 'signal', signal: 'SIGTERM' }).catch(() => {});
      await this.exit().catch(() => {});
    }
    this.child.stdin?.end();
    if (this.child.exitCode === null && this.child.signalCode === null)
      await once(this.child, 'exit');
    this.terminal.dispose();
  }
}
