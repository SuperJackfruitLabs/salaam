import { matchesKey, type Editor } from '@earendil-works/pi-tui';
import { searchHistory, searchPrompt } from './composer.js';

/** A reverse history search in progress: the query, the matching entry and the draft it replaces. */
export interface SearchState {
  query: string;
  index: number;
  draft: string;
}
/** What Ctrl+R search needs from the app; `search` is set while a search is open. */
export interface SearchHost {
  search?: SearchState;
  readonly editor: Pick<Editor, 'getText' | 'setText'>;
  readonly sent: { readonly entries: string[] };
  readonly client: { report(error: unknown): void };
}

/** Ctrl+R: start a reverse search through the messages this user sent. */
export function startSearch(host: SearchHost): void {
  host.search = { query: '', index: host.sent.entries.length, draft: host.editor.getText() };
  host.client.report(searchPrompt('', undefined));
}

/** Keys while Ctrl+R search is open: type to narrow, ctrl+r for older, enter keeps, esc restores. */
export function searchKey(host: SearchHost, s: SearchState, data: string): void {
  const entries = host.sent.entries;
  const show = () => {
    const match = s.index < entries.length ? entries[s.index] : undefined;
    if (match !== undefined) host.editor.setText(match);
    host.client.report(searchPrompt(s.query, match));
  };
  if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+g')) {
    host.editor.setText(s.draft);
    host.search = undefined;
    host.client.report('');
  } else if (matchesKey(data, 'enter') || matchesKey(data, 'right') || matchesKey(data, 'left')) {
    host.search = undefined;
    host.client.report('');
  } else if (matchesKey(data, 'ctrl+r')) {
    const found = searchHistory(entries, s.query, s.index);
    if (found >= 0) s.index = found;
    show();
  } else if (matchesKey(data, 'backspace')) {
    s.query = s.query.slice(0, -1);
    s.index = searchHistory(entries, s.query, entries.length);
    if (s.index < 0) s.index = entries.length;
    if (s.query === '') host.editor.setText(s.draft);
    show();
  } else if (data.length === 1 && data >= ' ' && data !== '\x7f') {
    s.query += data;
    const found = searchHistory(entries, s.query, Math.min(s.index + 1, entries.length));
    s.index = found >= 0 ? found : entries.length;
    if (found < 0) host.editor.setText(s.draft);
    show();
  }
}
