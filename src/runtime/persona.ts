import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { digest } from '../core/protocol.js';

/**
 * Item 9: the operator's persona for this host's agent. A plain UTF-8 text file the operator
 * reviews at `host plan`; the manifest pins its path and digest, `host start` refuses a changed
 * file, and every worker on the host gets it as a final system-prompt section. It shapes voice and
 * conduct only: it grants no tool, path or permission, and no workspace file can supply it.
 */
export const PERSONA_MAX_BYTES = 16 * 1024;
export interface Persona {
  text: string;
  digest: string;
}
export function loadPersona(path: string): Persona {
  if (!isAbsolute(path) || realpathSync(path) !== path)
    throw Error('Use a canonical absolute persona path');
  const st = statSync(path);
  if (!st.isFile() || st.size > PERSONA_MAX_BYTES)
    throw Error('A persona is a regular file of at most 16 KiB');
  const raw = readFileSync(path);
  const text = raw.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(raw) !== 0 || text.includes('\0'))
    throw Error('A persona is UTF-8 text');
  if (!text.trim()) throw Error('A persona must not be empty');
  return { text, digest: digest({ persona: text }) };
}
/** The section appended to the system prompt. */
export function personaSection(p: Persona): string {
  return (
    "\n\n## Persona (set by this host's operator)\n" +
    'This shapes your voice and conduct only. It grants no tools, paths or permissions, and it never ' +
    'overrides approvals, policy or the facts of a tool result.\n\n' +
    p.text.trim()
  );
}
