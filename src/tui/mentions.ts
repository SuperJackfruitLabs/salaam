import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { basename } from 'node:path';
import { listWorkspaceFiles, rankFiles } from '../runtime/mentions.js';

/**
 * `@` completes workspace files from git's own listing (ignored files stay out) instead of
 * pi-tui's `fd` walk, which is absent on most desks. The listing is cached for 5 s.
 */
export class MentionAutocompleteProvider extends CombinedAutocompleteProvider {
  private cache?: { at: number; files: string[] };
  constructor(
    commands: ConstructorParameters<typeof CombinedAutocompleteProvider>[0],
    private readonly root: string,
  ) {
    super(commands, root, null);
  }
  files(): string[] {
    if (!this.cache || Date.now() - this.cache.at > 5000)
      this.cache = { at: Date.now(), files: listWorkspaceFiles(this.root) };
    return this.cache.files;
  }
  override async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): ReturnType<CombinedAutocompleteProvider['getSuggestions']> {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
    const match = /(?:^|[\s([{])(@"[^"]*|@[^\s"]*)$/.exec(before);
    if (!match) return super.getSuggestions(lines, cursorLine, cursorCol, options);
    if (options.signal.aborted) return null;
    const prefix = match[1]!;
    const quoted = prefix.startsWith('@"');
    const items = rankFiles(this.files(), prefix.slice(quoted ? 2 : 1))
      .slice(0, 20)
      .map((file) => ({
        value: quoted || /\s/.test(file) ? `@"${file}"` : `@${file}`,
        label: basename(file),
        description: file,
      }));
    return items.length ? { items, prefix } : null;
  }
}
