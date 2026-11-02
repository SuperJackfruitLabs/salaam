// System prompt sections added after the session's own: board work reads first, and the operator's
// pinned persona last of all.
import { personaSection } from '../persona.js';
import type { House } from './context.js';

/** Phase 1 (2026-10-31): the model is told where its commands run, so it uses this host's tools
 * (step 0: it reached for GNU sed on a Mac). */
export function platformNote(): string {
  if (process.platform === 'darwin')
    return "Commands run on macOS under /bin/sh with BSD tools: use sed -i '' for in-place sed, no GNU-only flags (e.g. readlink -f, grep -P), and BSD date/stat syntax.";
  if (process.platform === 'linux') return 'Commands run on Linux under /bin/sh with GNU tools.';
  return `Commands run on ${process.platform} under /bin/sh.`;
}

export function registerPromptHooks(h: House): void {
  const { pi, c } = h;
  // Board work reads first (2026-10-28, cards F and G): a standing first step, the way a board
  // agent's own instructions make it one. Station root workers only: they are the ones with the tool.
  if (c.station && !c.child)
    pi.on('before_agent_start', (event) => ({
      systemPrompt:
        event.systemPrompt +
        '\n\nOn board work, before you write anything: call salaam_board with action card, then salaam_board with action library_search and the card title as the query. Use what you find; say when the library had nothing relevant.',
    }));
  // Item 9: the operator's pinned persona is the last section, after every other prompt change.
  if (c.persona) {
    const persona = c.persona;
    pi.on('before_agent_start', (event) => ({
      systemPrompt: event.systemPrompt + personaSection(persona),
    }));
  }
}
