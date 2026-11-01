import { execFile } from 'node:child_process';

/**
 * Salaam tells the terminal what it is doing (trial polish C, 2026-10-31): the window title says
 * working / needs you, and inside Herdr the pane reports its state through Herdr's documented
 * `pane report-agent` command (herdrdev/herdr, docs/next/.../add-herdr-support.mdx). Herdr's
 * docs define no OSC 7501 sequence, so none is sent. SALAAM_TERMINAL_STATUS=off turns both off.
 * Neither carries prompt text, command text or anything secret: only the state and a short
 * session name.
 */
export type TerminalState = 'idle' | 'working' | 'blocked';

export function terminalState(
  snapshot: { attempts?: { state: string }[]; approvals?: { state: string }[] } | undefined,
): TerminalState {
  if (!snapshot) return 'idle';
  if ((snapshot.approvals ?? []).some((a) => a.state === 'pending')) return 'blocked';
  if (
    (snapshot.attempts ?? []).some((a) => ['accepted', 'dispatching', 'running'].includes(a.state))
  )
    return 'working';
  return 'idle';
}

export function titleFor(state: TerminalState, name: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const clean = name
    ?.replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .trim()
    .slice(0, 32);
  if (!clean) return 'Salaam';
  const words = state === 'blocked' ? 'needs you' : state === 'working' ? 'working' : 'idle';
  return `Salaam · ${clean} · ${words}`;
}

export function statusEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SALAAM_TERMINAL_STATUS !== 'off';
}

type Run = (bin: string, args: string[], done: () => void) => void;
const run: Run = (bin, args, done) => {
  // Short timeout, failures ignored: Herdr must never slow Salaam down.
  execFile(bin, args, { timeout: 2000, windowsHide: true }, () => done());
};

/** Reports to Herdr only inside a Herdr pane; one report in flight, newest state wins. */
export class HerdrReporter {
  readonly enabled: boolean;
  private seq = 0;
  private busy = false;
  private queued?: string[];
  private last?: string;
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly exec: Run = run,
    private readonly now: () => number = Date.now,
  ) {
    this.enabled = !!(env.HERDR_ENV === '1' && env.HERDR_PANE_ID && env.HERDR_BIN_PATH);
  }
  private nextSeq(): string {
    this.seq = Math.max(this.seq + 1, this.now());
    return String(this.seq);
  }
  private head(verb: string): string[] {
    return ['pane', verb, this.env.HERDR_PANE_ID!, '--source', 'salaam', '--agent', 'salaam'];
  }
  report(state: TerminalState, session: string | undefined): void {
    if (!this.enabled) return;
    const key = state + ' ' + (session ?? '');
    if (key === this.last) return;
    this.last = key;
    this.queued = [
      ...this.head('report-agent'),
      '--state',
      state,
      '--seq',
      '',
      ...(state === 'blocked' ? ['--message', 'Waiting for your approval'] : []),
      ...(session ? ['--agent-session-id', session, '--', 'salaam', '--session', session] : []),
    ];
    this.flush();
  }
  release(): void {
    if (!this.enabled) return;
    this.queued = undefined;
    this.exec(
      this.env.HERDR_BIN_PATH!,
      [...this.head('release-agent'), '--seq', this.nextSeq()],
      () => {},
    );
  }
  private flush(): void {
    if (this.busy || !this.queued) return;
    const args = this.queued;
    this.queued = undefined;
    args[args.indexOf('--seq') + 1] = this.nextSeq();
    this.busy = true;
    this.exec(this.env.HERDR_BIN_PATH!, args, () => {
      this.busy = false;
      this.flush();
    });
  }
}
