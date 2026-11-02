import type { OperatorClient } from './client.js';
import type { SalaamTheme } from './theme.js';
import type { WorkspaceChange } from '../core/index.js';
import type { ReviewView } from './review.js';
import { toolLine, type ToolLine } from './activity.js';

// What every part of the screen renders from: the view model, and what is derived from it alone.

export type ViewTab = 'conversation' | 'changes' | 'commands' | 'context';
export interface DiffPage {
  revision: number;
  digest: string;
  changes: WorkspaceChange[];
  next_offset: number | null;
}
export interface ViewModel {
  client: OperatorClient;
  theme: SalaamTheme;
  tab: ViewTab;
  rows(): number;
  bodyRows(): number;
  diff?: DiffPage;
  diffOffset: number;
  log?: { id: string; text: string; offset: number; complete: boolean };
  busy: boolean;
  continuation?: string;
  /** The Changes tab of a local coding session (tui-review.ts). */
  review?: ReviewView;
  /** Phase 2b: the session's mode, its access (full access or YOLO) and where commands run. */
  mode?: { mode: string; access?: 'full' | 'yolo'; sandbox?: string };
  /** Trial polish #9: every tool call with its full recorded output, not the compact lines. */
  transcript?: boolean;
  /** When the running turn was first seen, for the progress line's elapsed seconds. */
  turn?: { attempt: string; since: number };
}
/** The session's tool calls, oldest first, each as one compact line. */
export function toolLines(
  view: ViewModel,
): (ToolLine & { parent?: string; key: string; output?: string })[] {
  const calls = new Map<
    string,
    {
      tool: string;
      input?: string;
      finished?: { failed?: boolean; output?: string };
      parent?: string;
    }
  >();
  for (const event of view.client.activity) {
    const p = event.payload;
    const key = p.attempt_id + ':' + p.tool_call_id;
    const before = calls.get(key);
    calls.set(key, {
      tool: p.tool,
      input: event.kind === 'tool.started' ? p.input : before?.input,
      finished:
        event.kind === 'tool.finished' ? { failed: p.failed, output: p.output } : before?.finished,
      parent: p.parent_tool_call_id ? p.attempt_id + ':' + p.parent_tool_call_id : before?.parent,
    });
  }
  return [...calls.entries()].map(([key, c]) => {
    const line = toolLine(c.tool, c.input, c.finished);
    // A command's recorded result is JSON; the transcript shows its output as text.
    return { key, parent: c.parent, output: line.full ?? c.finished?.output, ...line };
  });
}
/** How the status line names a mode. */
export function modelLabel(client: OperatorClient): string {
  const route = client.snapshot?.provider_route ?? client.health?.provider_route;
  if (!route) return 'Connect your workspace';
  if (['offline', 'salaam-proof'].includes(route.provider)) return 'Offline demo';
  const warning =
    (client.snapshot?.provider_capabilities ?? client.health?.provider_capabilities)
      ?.output_token_cap === false
      ? ' · no output cap'
      : '';
  return (
    route.model.replace('claude-sonnet-', 'Claude Sonnet ').replace(/(\d)-(\d)$/, '$1.$2') + warning
  );
}
/** 950 → "950", 12_400 → "12.4k", 2_300_000 → "2.3M". */
