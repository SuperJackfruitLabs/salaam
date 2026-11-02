import { PI_PROVIDERS } from '../../core/index.js';
import {
  getProvider,
  readSecret,
  validateApiKey,
  authDirectory,
  ProviderCredentialStore,
  providerModels,
  loginProvider,
} from '../../providers/index.js';
import { createInterface } from 'node:readline/promises';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import type { CliContext } from './context.js';

export const PROVIDERS_HELP = `salaam providers list

List every provider in the pinned Pi registry, its chat APIs and auth methods.
Catalog support does not imply live account access or verification.`;
export const MODELS_HELP = `salaam models list [PROVIDER]

List pinned chat model IDs without network requests or credentials.`;
export const AUTH_HELP = `salaam auth set PROVIDER
salaam auth login PROVIDER [--oauth]
salaam auth status [PROVIDER]
salaam auth logout PROVIDER

Set an API key at a hidden prompt (or pipe it on stdin). Login uses Pi's provider-owned
setup, including cloud configuration and browser OAuth. Credentials are private under
~/.config/salaam/credentials; refresh is serialized across processes.
Status prints metadata only. Existing Anthropic keys remain compatible.`;

/** salaam providers list. */
export async function providersCommand(ctx: CliContext): Promise<boolean> {
  const { group, verb } = ctx;
  if (group === 'providers' && verb === 'list') {
    console.log(
      JSON.stringify(
        PI_PROVIDERS.map((p) => ({
          id: p.id,
          name: p.name,
          chat_models: p.getModels().length,
          apis: [...new Set(p.getModels().map((m) => m.api))],
          auth: [p.auth.apiKey ? 'api_key' : null, p.auth.oauth ? 'oauth' : null].filter(Boolean),
          limitation: !p.getModels().length
            ? 'Classifier only; no chat route'
            : p.id === 'openai-codex'
              ? 'No provider-enforced output cap; tasks must explicitly disable token budgeting'
              : null,
        })),
        null,
        2,
      ),
    );
    return true;
  }
  return false;
}
/** salaam models list. */
export async function modelsCommand(ctx: CliContext): Promise<boolean> {
  const { group, verb, id } = ctx;
  if (group === 'models' && verb === 'list') {
    const providers = id ? [getProvider(id)] : PI_PROVIDERS;
    if (providers.some((p) => !p)) throw new Error('Unknown Pi provider');
    console.log(
      JSON.stringify(
        providers.flatMap((p) =>
          p!.getModels().map((m) => ({
            provider: p!.id,
            id: m.id,
            name: m.name,
            api: m.api,
            context_window: m.contextWindow,
            max_output_tokens: m.maxTokens,
          })),
        ),
        null,
        2,
      ),
    );
    return true;
  }
  return false;
}
/** salaam auth: credentials and sign-in. */
export async function authCommand(ctx: CliContext): Promise<boolean> {
  const { args, group, verb, id } = ctx;
  if (group === 'auth') {
    const store = new ProviderCredentialStore();
    if (verb === 'status') {
      const models = providerModels(store),
        entries = id ? [getProvider(id)] : PI_PROVIDERS;
      if (entries.some((p) => !p)) throw new Error('Unknown Pi provider');
      const statuses = [];
      for (const p of entries) {
        try {
          const auth = await models.checkAuth(p!.id);
          statuses.push({
            provider: p!.id,
            configured: !!auth,
            type: auth?.type ?? null,
            source: auth?.source ?? null,
          });
        } catch {
          statuses.push({ provider: p!.id, configured: false, error: 'Credential check failed' });
        }
      }
      console.log(JSON.stringify(statuses, null, 2));
      return true;
    }
    if (!id || !getProvider(id)) throw new Error('Choose a provider from salaam providers list');
    if (verb === 'logout') {
      await store.delete(id);
      console.log(
        'Stored credential removed for ' + id + '. Environment credentials remain external.',
      );
      return true;
    }
    if (verb === 'set') {
      if (!getProvider(id)!.auth.apiKey)
        throw new Error('This provider needs salaam auth login ' + id + ' --oauth');
      const key = (await readSecret(id + ' API key (hidden): ')).trim();
      if (
        !key ||
        key.length > 4096 ||
        /[^\x21-\x7e]/.test(key) ||
        (id === 'anthropic' && key.includes('sk-ant-oat'))
      )
        throw new Error('Supply a provider API key, not an OAuth token');
      if (id === 'anthropic') validateApiKey(key);
      await store.modify(id, async () => ({ type: 'api_key', key }));
      console.log(
        'API key saved privately for ' + id + ' under ' + authDirectory() + ' (mode 600).',
      );
      return true;
    }
    if (verb === 'login') {
      if (!process.stdin.isTTY)
        throw new Error(
          'Interactive login needs a terminal; use auth set PROVIDER for a piped API key',
        );
      const provider = getProvider(id)!;
      const type = args.includes('--oauth') || !provider.auth.apiKey ? 'oauth' : 'api_key';
      const interaction: AuthInteraction = {
        async prompt(prompt) {
          if (prompt.type === 'secret')
            return readSecret(prompt.message + ' (hidden): ', prompt.signal);
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const choices =
              prompt.type === 'select'
                ? '\n' + prompt.options.map((v, i) => `${i + 1}. ${v.label} (${v.id})`).join('\n')
                : '';
            const answer = await rl.question(prompt.message + choices + '\n> ', {
              signal: prompt.signal,
            });
            return prompt.type === 'select' && /^\d+$/.test(answer)
              ? (prompt.options[Number(answer) - 1]?.id ?? answer)
              : answer;
          } finally {
            rl.close();
          }
        },
        notify(event) {
          if (event.type === 'auth_url')
            console.error(
              'Open in your browser: ' +
                event.url +
                (event.instructions ? '\n' + event.instructions : ''),
            );
          else if (event.type === 'device_code')
            console.error('Open ' + event.verificationUri + ' and enter ' + event.userCode);
          else console.error(event.message);
        },
      };
      await loginProvider(id, type, interaction);
      console.log(
        'Signed in to ' +
          id +
          ' with ' +
          type +
          '. Restart the service to use a different provider route.',
      );
      return true;
    }
    throw new Error('Run salaam auth --help');
  }
  return false;
}
