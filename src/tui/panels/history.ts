import { call } from '../../core/index.js';
import { TextModal } from '../modals.js';
import { shortId } from '../theme.js';
import type { PanelContext } from './context.js';

// The session's complete history, paged from the service, the saved evidence it points to, and
// the recorded tool activity.

export async function history(ctx: PanelContext, offset = 0): Promise<void> {
  const id = ctx.client.snapshot?.id;
  if (!id) return;
  const page = await call<{ entries: { entry_id: string }[]; next_offset: number | null }>(
    ctx.client.socket,
    `/v1/sessions/${id}/history?offset=${offset}`,
  );
  ctx.choice(
    'Session history · entries ' + (offset + 1) + '–' + (offset + page.entries.length),
    [
      ...page.entries.map((entry) => ({ value: entry.entry_id, label: entry.entry_id })),
      ...(page.next_offset === null ? [] : [{ value: 'next-page', label: 'Next page →' }]),
    ],
    (value) =>
      void ctx.execute(() =>
        value === 'next-page' ? history(ctx, page.next_offset!) : evidence(ctx, 'entry_id', value),
      ),
  );
}
export async function evidence(
  ctx: PanelContext,
  kind: 'entry_id' | 'artifact_id',
  value: string,
  offset = 0,
): Promise<void> {
  const id = ctx.client.snapshot?.id;
  if (!id) return;
  const page = await call<{ text: string; next_offset: number | null }>(
    ctx.client.socket,
    `/v1/sessions/${id}/history?${kind}=${encodeURIComponent(value)}&offset=${offset}`,
  );
  if (ctx.client.snapshot?.id !== id) return;
  ctx.showModal(
    new TextModal(
      (kind === 'entry_id' ? 'History · ' : 'Artifact · ') + shortId(value),
      page.text,
      ctx.view.theme,
      () => ctx.terminal.rows,
      () => ctx.tui.requestRender(),
      () => ctx.closeModal(),
      page.next_offset === null
        ? undefined
        : () => void ctx.execute(() => evidence(ctx, kind, value, page.next_offset!)),
    ),
    100,
  );
}
export function tools(ctx: PanelContext): void {
  const events = ctx.client.activity.filter((event) => event.kind === 'tool.started');
  if (!events.length) {
    ctx.client.report('No recorded tool activity yet.');
    return;
  }
  ctx.choice(
    'Tool activity',
    events.map((event) => ({
      value: String(event.seq),
      label: event.payload.tool,
      description: shortId(event.payload.attempt_id) + ' · ' + event.payload.tool_call_id,
    })),
    (value) => {
      const event = events.find((e) => String(e.seq) === value)!;
      const p = event.payload;
      const outcome = ctx.client.activity.find(
        (other) =>
          other.kind === 'tool.finished' &&
          other.payload.attempt_id === p.attempt_id &&
          other.payload.tool_call_id === p.tool_call_id,
      );
      ctx.showModal(
        new TextModal(
          'Tool · ' + p.tool,
          `Attempt: ${p.attempt_id}\nTool call: ${p.tool_call_id}\nOutcome: ${outcome ? (outcome.payload.failed ? 'failed' : 'finished') : 'running or not captured'}\nInput${p.input_truncated ? ' (truncated; full digest recorded)' : ''}:\n${p.input ?? '(not captured)'}`,
          ctx.view.theme,
          () => ctx.terminal.rows,
          () => ctx.tui.requestRender(),
          () => ctx.closeModal(),
        ),
        100,
      );
    },
  );
}
