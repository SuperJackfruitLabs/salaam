// A session's conversation replayed to the editor from the service's history: each message part
// and tool call once, in transcript order.
import { call, object, toolMetadata, toolTitle } from '../core/index.js';
import { text, update, type AcpContext, type Connection, type Json } from './context.js';

/** The largest single history entry the adapter reads. */
const ENTRY_LIMIT = 4 * 1024 * 1024;

async function toolDetails(
  ctx: AcpContext,
  session: string,
  id: string,
  name: string,
  input: unknown,
) {
  return (
    (await call<Json | null>(
      ctx.socket,
      `/v1/sessions/${session}/tool-metadata?call_id=${encodeURIComponent(id)}`,
    )) ?? toolMetadata(name, input)
  );
}

async function readEntry(ctx: AcpContext, id: string, entry: string): Promise<Json> {
  let content = '',
    offset: number | null = 0;
  while (offset !== null) {
    const page: { text: string; next_offset: number | null } = await call(
      ctx.socket,
      `/v1/sessions/${id}/history?entry_id=${encodeURIComponent(entry)}&offset=${offset}`,
    );
    content += page.text;
    offset = page.next_offset;
    if (content.length > ENTRY_LIMIT) throw new Error('Pi history entry exceeds protocol limit');
  }
  return object(JSON.parse(content));
}

export async function replay(
  ctx: AcpContext,
  c: Connection,
  emit: boolean,
  includeUsers = false,
): Promise<void> {
  let offset: number | null = 0;
  while (offset !== null && !ctx.closed) {
    const page: { entries: { entry_id: string }[]; next_offset: number | null } = await call(
      ctx.socket,
      `/v1/sessions/${c.id}/history?branch=true&offset=${offset}`,
    );
    for (const item of page.entries) {
      if (c.seen.has(item.entry_id)) continue;
      const entry = await readEntry(ctx, c.id, item.entry_id);
      if (emit && entry.message)
        await replayMessage(ctx, c, object(entry.message), item.entry_id, includeUsers);
      c.seen.add(item.entry_id);
    }
    offset = page.next_offset;
  }
}

async function replayMessage(
  ctx: AcpContext,
  c: Connection,
  message: Json,
  entryId: string,
  includeUsers: boolean,
): Promise<void> {
  const parts =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content)
        ? message.content.map(object)
        : [];
  if (message.role === 'user' || message.role === 'assistant') {
    for (const [partIndex, part] of parts.entries()) {
      // The editor already displays its submitted prompt. User chunks belong
      // to explicit history loading, otherwise Zed renders a second copy.
      if (
        part.type === 'text' &&
        typeof part.text === 'string' &&
        (message.role !== 'user' || includeUsers)
      )
        await text(ctx, c.id, message.role, part.text, entryId, partIndex);
      if (part.type === 'toolCall' && !c.liveTools.has(String(part.id))) {
        c.liveTools.add(String(part.id));
        await update(ctx, c.id, {
          sessionUpdate: 'tool_call',
          toolCallId: String(part.id),
          title: toolTitle(String(part.name), part.arguments),
          ...(await toolDetails(ctx, c.id, String(part.id), String(part.name), part.arguments)),
          status: 'in_progress',
          rawInput: part.arguments,
        });
      }
    }
  } else if (message.role === 'toolResult')
    await update(ctx, c.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: String(message.toolCallId),
      status: message.isError ? 'failed' : 'completed',
      content: parts.filter((p) => p.type === 'text').map((p) => ({ type: 'content', content: p })),
    });
}
