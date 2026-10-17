import {
  styleText,
  parseColor,
  getTerminalColorMode,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type MarkdownTheme,
} from '@earendil-works/pi-tui';

export type ThemeName = 'night' | 'paper';
export type Ink = 'text' | 'muted' | 'jade' | 'amber' | 'red' | 'blue' | 'border';
const palettes = {
  night: {
    bg: '#0c1618',
    panel: '#112125',
    selected: '#1b3437',
    text: '#e5eee9',
    muted: '#8ca9a3',
    jade: '#86dbb5',
    amber: '#e8c78c',
    red: '#f0989d',
    blue: '#9dc7e5',
    border: '#2b494b',
  },
  paper: {
    bg: '#f7f5ed',
    panel: '#edeee5',
    selected: '#dce9de',
    text: '#253b35',
    muted: '#61776d',
    jade: '#216b52',
    amber: '#8c5b15',
    red: '#a53648',
    blue: '#326580',
    border: '#c4d1c6',
  },
} as const;
const indexedPalettes = {
  night: {
    bg: 233,
    panel: 234,
    selected: 237,
    text: 255,
    muted: 109,
    jade: 115,
    amber: 223,
    red: 210,
    blue: 153,
    border: 66,
  },
  paper: {
    bg: 255,
    panel: 254,
    selected: 194,
    text: 237,
    muted: 65,
    jade: 29,
    amber: 94,
    red: 131,
    blue: 24,
    border: 250,
  },
} as const;
export function safeText(text: unknown): string {
  return stripTerminalSequences(String(text ?? '')).replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    '',
  );
}
export function shortId(id: string | null | undefined): string {
  return id?.slice(0, 8) ?? '—';
}
export function compactPath(path: string, home?: string): string {
  return safeText(home && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path);
}
export function humanTool(tool: string, input?: string): string {
  let action = '',
    path = '';
  try {
    const args = JSON.parse(input ?? '{}');
    action = args.action ?? '';
    path = args.path ? ' · ' + safeText(args.path) : '';
  } catch {}
  const names: Record<string, string> = {
    salaam_probe: 'Inspect session',
    salaam_review: 'Request approval',
    salaam_effect: 'Managed operation',
    spawn_child: 'Delegate read-only work',
    inspect_child: 'Inspect child',
    consume_child_result: 'Read child result',
    salaam_history: 'Read history',
    salaam_files:
      (
        {
          read: 'Read file',
          list: 'List files',
          search: 'Search workspace',
          patch: 'Patch file',
          inspect: 'Inspect workspace',
        } as Record<string, string>
      )[action] ?? 'Workspace',
    salaam_command: 'Run command',
  };
  return (names[tool] ?? safeText(tool)) + path;
}
export class SalaamTheme {
  constructor(
    readonly name: ThemeName = 'night',
    readonly color = !('NO_COLOR' in process.env),
  ) {}
  get palette() {
    return palettes[this.name];
  }
  private paint(role: Ink | 'bg' | 'panel' | 'selected') {
    return parseColor(
      getTerminalColorMode() === '256color' ? indexedPalettes[this.name][role] : this.palette[role],
    );
  }
  ink(text: string, role: Ink = 'text', bold = false): string {
    if (!this.color) return text;
    return styleText(text, { fg: this.paint(role), bold }, getTerminalColorMode());
  }
  fill(text: string, width: number, surface: 'bg' | 'panel' | 'selected' = 'bg'): string {
    const clipped = truncateToWidth(text, Math.max(1, width), '');
    const padded = clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
    if (!this.color) return padded;
    return styleText(padded, { bg: this.paint(surface) }, getTerminalColorMode());
  }
  line(text: string, width: number, surface: 'bg' | 'panel' | 'selected' = 'bg'): string {
    return this.fill('  ' + text, width, surface);
  }
  rule(width: number): string {
    return this.fill(this.ink('─'.repeat(Math.max(0, width)), 'border'), width);
  }
  key(key: string, label: string): string {
    return this.ink(key, 'jade') + this.ink(' ' + label, 'muted');
  }
  markdown(): MarkdownTheme {
    return {
      heading: (s) => this.ink(s, 'jade', true),
      link: (s) => this.ink(s, 'blue'),
      linkUrl: (s) => this.ink(s, 'muted'),
      code: (s) => this.ink(s, 'jade'),
      codeBlock: (s) => this.ink(s),
      codeBlockBorder: (s) => this.ink(s, 'border'),
      quote: (s) => this.ink(s, 'muted'),
      quoteBorder: (s) => this.ink(s, 'jade'),
      hr: (s) => this.ink(s, 'border'),
      listBullet: (s) => this.ink(s, 'jade'),
      bold: (s) => this.ink(s, 'text', true),
      italic: (s) => this.ink(s, 'muted'),
      strikethrough: (s) => this.ink(s, 'muted'),
      underline: (s) => this.ink(s, 'blue'),
      highlightCode: (code, lang) => this.highlight(code, lang),
    };
  }
  highlight(code: string, language?: string): string[] {
    return safeText(code)
      .split('\n')
      .map((line) => {
        if (language === 'diff')
          return this.ink(
            line,
            line.startsWith('+')
              ? 'jade'
              : line.startsWith('-')
                ? 'red'
                : line.startsWith('@@')
                  ? 'blue'
                  : 'muted',
          );
        const token =
          /(\/\/.*$|#.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|\b(?:const|let|var|function|return|export|import|from|async|await|class|if|else|try|catch|throw|def|for|in|true|false|null|None|True|False)\b|\b\d+(?:\.\d+)?\b)/g;
        let result = '',
          cursor = 0;
        for (const match of line.matchAll(token)) {
          result += this.ink(line.slice(cursor, match.index));
          const value = match[0];
          result += this.ink(
            value,
            /^(\/\/|#)/.test(value)
              ? 'muted'
              : /^["'`]/.test(value)
                ? 'jade'
                : /^\d/.test(value)
                  ? 'amber'
                  : 'blue',
          );
          cursor = match.index + value.length;
        }
        return result + this.ink(line.slice(cursor));
      });
  }
}
