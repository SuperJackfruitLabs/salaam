/** /classifier (operator 2026-10-31): the command reviewer has its own model selection. */
export interface ClassifierView {
  configured: boolean;
  enabled: boolean;
  choice: string;
  pinned: boolean;
  model?: string;
  on_unavailable?: string;
  options: { name: string; provider: string; model: string }[];
}

/** Picker rows: every configured reviewer, then Off. Empty when there is nothing to choose. */
export function classifierItems(v: ClassifierView) {
  if (!v.configured || v.pinned) return [];
  const mark = (on: boolean) => (on ? '● ' : '○ ');
  return [
    ...v.options.map((o) => ({
      value: o.name,
      label: mark(v.choice === o.name) + o.name,
      description: `${o.provider} · ${o.model}`,
    })),
    { value: 'off', label: mark(v.choice === 'off') + 'Off', description: 'Rules only' },
  ];
}

export function classifierNotice(v: ClassifierView): string {
  if (!v.configured && v.choice === 'off' && !v.pinned)
    return 'No command reviewer is configured; set --danger-classifier-config on the service.';
  const what = v.enabled
    ? `Command reviewer ${v.choice} (${v.model}) is on for this session` +
      ` (if it does not answer: ${v.on_unavailable === 'ask' ? 'ask' : 'rules only'})`
    : 'Command reviewer is off for this session';
  return (
    what +
    (v.pinned ? ', pinned by this host' : '') +
    '. It can only make a command ask, never let one run.'
  );
}
