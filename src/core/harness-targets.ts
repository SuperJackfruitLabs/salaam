/** The pinned external harnesses Salaam can drive. Pure data; imports nothing from src. */
export const HARNESS_TARGETS = {
  'gemini-acp': { dialect: 'acp', args: ['--acp'], version: '0.64.0' },
  'claude-acp': { dialect: 'acp', args: [], version: '0.23.1' },
  'codex-app-server': { dialect: 'codex', args: ['app-server'], version: '0.163.0' },
} as const;
export type HarnessTarget = keyof typeof HARNESS_TARGETS;
