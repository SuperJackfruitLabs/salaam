import { writeFileSync } from 'node:fs';
import { call } from './transport.js';
/** Read all immutable captured entries, including history before compaction. */
export async function conversationExport(socket: string, id: string): Promise<string> {
  const entries: string[] = [];
  let offset: number | null = 0;
  let bytes = 0;
  do {
    const page: { entries: { entry_id: string }[]; next_offset: number | null } = await call(
      socket,
      `/v1/sessions/${id}/history?offset=${offset}`,
    );
    for (const entry of page.entries) {
      let part: number | null = 0,
        text = '';
      do {
        const chunk: { text: string; next_offset: number | null } = await call(
          socket,
          `/v1/sessions/${id}/history?entry_id=${encodeURIComponent(entry.entry_id)}&offset=${part}`,
        );
        text += chunk.text;
        bytes += Buffer.byteLength(chunk.text);
        if (bytes > 32 * 1024 * 1024)
          throw new Error('Export exceeds 32 MiB; no file was written.');
        if (chunk.next_offset !== null && chunk.next_offset <= part!)
          throw new Error('Invalid history pagination');
        part = chunk.next_offset;
      } while (part !== null);
      // JSON remains complete, including tool receipts, rather than a misleading recent-message slice.
      const fence = '`'.repeat(
        Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)),
      );
      entries.push(`## Entry ${entry.entry_id}\n\n${fence}json\n${text}\n${fence}`);
    }
    if (page.next_offset !== null && page.next_offset <= offset!)
      throw new Error('Invalid history pagination');
    offset = page.next_offset;
  } while (offset !== null);
  return `# Salaam session ${id}\n\nCaptured append-order history, including pre-compaction records.\n\n${entries.join('\n\n')}\n`;
}
export function writeConversationExport(path: string, text: string): void {
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
}
