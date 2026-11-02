/**
 * A circuit breaker for agent fetches (operator MCP calls whose arguments carry a `url`). After
 * repeated consecutive failures to one host within a session, calls to that host are paused for a
 * short while: the agent gets a tool error saying so and can do something else, and the run's
 * activity gets one line. Nothing fails the run, and a paused call is never made, so it records no
 * operator MCP call. One success to the host closes the breaker again.
 */
export const BREAKER_FAILURES = 3;
export const BREAKER_PAUSE_MS = 60_000;

export function fetchHost(args: unknown): string | null {
  const url = (args as { url?: unknown } | null)?.url;
  if (typeof url !== 'string') return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

export class HostBreaker {
  private readonly hosts = new Map<string, { failures: number; until: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  private key(session: string, host: string) {
    return session + '\u0000' + host;
  }
  /** Milliseconds this host stays paused for the session, 0 when calls may go ahead. */
  paused(session: string, host: string): number {
    const h = this.hosts.get(this.key(session, host));
    return h ? Math.max(0, h.until - this.now()) : 0;
  }
  /** Records a call's outcome; true when this failure just opened the breaker. */
  record(session: string, host: string, ok: boolean): boolean {
    const key = this.key(session, host);
    if (ok) {
      this.hosts.delete(key);
      return false;
    }
    const h = this.hosts.get(key) ?? { failures: 0, until: 0 };
    h.failures++;
    this.hosts.set(key, h);
    if (h.failures < BREAKER_FAILURES) return false;
    h.failures = 0;
    h.until = this.now() + BREAKER_PAUSE_MS;
    return true;
  }
  forget(session: string): void {
    for (const key of this.hosts.keys())
      if (key.startsWith(session + '\u0000')) this.hosts.delete(key);
  }
}

type McpResult = { content: { type: 'text'; text: string }[]; is_error: boolean };
/**
 * One operator MCP call through the breaker. A paused host returns a tool error without calling;
 * a thrown failure or a tool error counts against the host; the call that opens the breaker
 * records `fetch.host_paused` for the run's activity. The call's own result or error is unchanged.
 */
export async function callThroughBreaker(
  breaker: HostBreaker,
  session: string,
  args: unknown,
  event: (payload: Record<string, unknown>) => void,
  call: () => Promise<McpResult>,
): Promise<McpResult> {
  const host = fetchHost(args);
  if (!host) return call();
  const wait = breaker.paused(session, host);
  if (wait)
    return {
      content: [
        {
          type: 'text',
          text: `Requests to ${host} are paused for ${Math.ceil(wait / 1000)}s after repeated failures; try another source or retry later.`,
        },
      ],
      is_error: true,
    };
  let ok = false;
  try {
    const result = await call();
    ok = !result.is_error;
    return result;
  } finally {
    if (breaker.record(session, host, ok))
      event({ host, failures: BREAKER_FAILURES, pause_ms: BREAKER_PAUSE_MS });
  }
}
