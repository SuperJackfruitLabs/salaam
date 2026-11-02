/** A provider and model a turn runs on. Pure; imports nothing from src. */
export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export interface ProviderRoute {
  reasoning?: ReasoningLevel;
  provider: string;
  model: string;
  max_tokens: number;
  workspace_id?: string;
  connection?: { endpoint: string; configuration: Record<string, string> };
}
export const OFFLINE_ROUTE: ProviderRoute = {
  provider: 'salaam-proof',
  model: 'scripted',
  max_tokens: 1024,
};
