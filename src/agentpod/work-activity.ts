// The latest tool steps of a run, oldest first, for the owner to show as card activity.
import { toolMetadata, toolTitle } from '../core/index.js';
import type { Store } from '../store/index.js';

/** Tool input and output are clipped to this many characters on the card. */
const ACTIVITY_TEXT = 2048;

/** The latest tool steps, oldest first, for the owner to show as card activity while the work
 * runs. Observation only: it carries no authority and changes nothing. Input is clipped. */
export function workActivity(store: Pick<Store, 'db'>, session: string) {
  const startedOf = store.db.prepare(
    "SELECT json_extract(payload,'$.input') AS input FROM events WHERE session_id=? AND kind='tool.started' AND json_extract(payload,'$.tool_call_id')=? ORDER BY seq DESC LIMIT 1",
  );
  const startedInput = (id: unknown) =>
    typeof id === 'string'
      ? (startedOf.get(session, id) as { input?: unknown } | undefined)?.input
      : undefined;
  return store.db
    .prepare(
      "SELECT seq,kind,payload FROM events WHERE session_id=? AND kind IN ('tool.started','tool.finished','permission.auto-approved','fetch.host_paused') ORDER BY seq DESC LIMIT 64",
    )
    .all(session)
    .reverse()
    .map((row) => {
      const p = JSON.parse(String(row.payload)) as Record<string, unknown>;
      // Approval scopes: a write the run grant answered says so on the card, with the grant.
      // A fetch host paused by the breaker: one line, and the run carries on.
      if (row.kind === 'fetch.host_paused')
        return {
          seq: Number(row.seq),
          phase: 'finished' as const,
          tool_call_id: 'fetch-pause:' + String(row.seq),
          title: `Paused requests to ${String(p.host)} for ${Math.round(Number(p.pause_ms) / 1000)}s after ${Number(p.failures)} failures`,
          kind: null,
          input: null,
          failed: false,
        };
      if (row.kind === 'permission.auto-approved')
        return {
          seq: Number(row.seq),
          phase: 'finished' as const,
          tool_call_id: 'approval:' + String(p.operation_id ?? ''),
          title:
            p.rule === 'run-grant'
              ? 'Approved by the run grant' +
                (typeof p.granted_by === 'string' ? ` (granted by ${p.granted_by})` : '')
              : p.rule === 'agent-rule'
                ? "Allowed by the agent's standing rule" +
                  (typeof p.set_by === 'string' ? ` (set by ${p.set_by})` : '')
                : 'Approved by a standing policy',
          kind: null,
          input: null,
          failed: false,
        };
      const started = row.kind === 'tool.started',
        tool = typeof p.tool === 'string' ? p.tool : '';
      const input = typeof p.input === 'string' ? p.input.slice(0, ACTIVITY_TEXT) : null;
      // A finished step carries no input, so it is titled from the call it finishes: the card
      // read a bare "salaam_station" under every station step (staging card_3a97983751784bf9).
      const callInput = started ? p.input : startedInput(p.tool_call_id);
      return {
        seq: Number(row.seq),
        phase: started ? ('started' as const) : ('finished' as const),
        tool_call_id: typeof p.tool_call_id === 'string' ? p.tool_call_id : '',
        title: tool ? toolTitle(tool, callInput) : 'Tool',
        kind: started ? String(p.kind ?? toolMetadata(tool, p.input).kind) : null,
        input: started ? input : null,
        failed: !started && p.failed === true,
        // The tool's text output, already redacted and clipped by the worker, so the card shows
        // what the step returned as Hermes does.
        ...(!started && typeof p.output === 'string'
          ? { output: p.output.slice(0, ACTIVITY_TEXT) }
          : {}),
      };
    });
}
