import { HARNESS_TARGETS, type HarnessTarget } from './harness-probe.js';
import { ServiceError } from './protocol.js';
/** Correlation only: these IDs never authenticate a worker or grant operator authority. */
export function harnessToolIds(
  target: HarnessTarget,
  version: string,
  intent: { id: string; name: string },
): string[] {
  if (
    !Object.hasOwn(HARNESS_TARGETS, target) ||
    HARNESS_TARGETS[target].version !== version ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(intent.id) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(intent.name)
  )
    throw new ServiceError(
      'harness_tool_identity',
      'Unproved runtime or malformed model tool identity',
    );
  // Gemini 0.64.0 namespaces model-call IDs when projecting them into ACP tool calls.
  return target === 'gemini-acp' ? [intent.id, intent.name + '__' + intent.id] : [intent.id];
}

/** Parse only literal shell argv displays; never evaluate expansions, redirections or operators. */
function literalWords(display: string): string[] | null {
  const words: string[] = [];
  let word = '',
    quote = '',
    present = false;
  for (let i = 0; i < display.length; i++) {
    const c = display[i]!;
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
    } else if (c === '\\') {
      const next = display[++i];
      if (next === undefined || next === '\n') return null;
      if (quote === '"' && !['"', '\\', '$', '`'].includes(next)) word += '\\';
      word += next;
      present = true;
    } else if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '$' || c === '`') return null;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      present = true;
    } else if (c === '\n' || c === '\r') return null;
    else if (/\s/.test(c)) {
      if (present) words.push(word);
      word = '';
      present = false;
    } else {
      if (';&|<>()$`*?[]{}~#'.includes(c)) return null;
      word += c;
      present = true;
    }
  }
  if (quote) return null;
  if (present) words.push(word);
  return words;
}

/** Correlate the pinned app-server's concrete shell display with an independently captured model call. No grant is implied. */
export function matchesCodexCommandScope(
  version: string,
  intent: { id: string; name: string; arguments: Record<string, unknown> } | undefined,
  params: Record<string, unknown>,
): boolean {
  if (
    version !== HARNESS_TARGETS['codex-app-server'].version ||
    !intent ||
    intent.name !== 'exec_command' ||
    intent.id !== params.itemId ||
    typeof intent.arguments.cmd !== 'string' ||
    typeof params.command !== 'string' ||
    typeof intent.arguments.workdir !== 'string' ||
    params.cwd !== intent.arguments.workdir ||
    intent.arguments.shell !== undefined ||
    intent.arguments.login === false
  )
    return false;
  const words = literalWords(params.command);
  return (
    words?.length === 3 &&
    // The pinned image exposes Bash at both paths. Codex selects /bin/bash
    // for its UID-1000 passwd entry and /usr/bin/bash for an unmapped UID.
    ['/usr/bin/bash', '/bin/bash'].includes(words[0]!) &&
    words[1] === '-lc' &&
    words[2] === intent.arguments.cmd
  );
}
