import { statSync } from 'node:fs';
import { typedText } from '../local/index.js';

/** What the picker shows for a desk session: its newest prompt (at most 200 characters) and when
 * its transcript last changed. Board and station sessions get nothing extra. */
export function pickerSummary(
  session: { id: string; capabilities: string[]; pi_session_file: string | null },
  store: { lastPrompt(id: string): string | null },
): { last_prompt?: string; last_active_at?: string } {
  if (!session.capabilities.includes('local-coding-reviewed')) return {};
  const prompt = store.lastPrompt(session.id);
  let at: string | undefined;
  try {
    if (session.pi_session_file) at = statSync(session.pi_session_file).mtime.toISOString();
  } catch {
    /* no transcript yet */
  }
  return {
    ...(prompt ? { last_prompt: typedText(prompt).slice(0, 200) } : {}),
    ...(at ? { last_active_at: at } : {}),
  };
}
