import { PI_PROVIDERS, REASONING_LEVELS, type ReasoningLevel } from '../../core/index.js';
import { providerRoute } from '../../providers/index.js';
import type { SlashCommand } from './types.js';

// The session's provider, model and reasoning effort.

const modelCommand: SlashCommand = {
  names: ['model'],
  session: false,
  async run(ctx, args) {
    if (!args) {
      ctx.modelPicker();
      return;
    }
    const slash = args.indexOf('/');
    if (slash <= 0) throw new Error('Use /model provider/model.');
    await ctx.applyRoute(providerRoute(args.slice(0, slash), args.slice(slash + 1)));
  },
};

const providerCommand: SlashCommand = {
  names: ['provider'],
  session: false,
  async run(ctx, args) {
    if (!args) {
      ctx.modelPicker();
      return;
    }
    if (args === 'offline') {
      await ctx.applyRoute(providerRoute());
      return;
    }
    const provider = PI_PROVIDERS.find((p) => p.id === args);
    if (!provider) throw new Error('Unknown provider. Use /provider to browse the pinned catalog.');
    ctx.choice(
      'Model · ' + provider.name,
      provider.getModels().map((m) => ({ value: m.id, label: m.name, description: m.id })),
      (model) => void ctx.execute(() => ctx.applyRoute(providerRoute(args, model))),
    );
  },
};

const thinkingCommand: SlashCommand = {
  names: ['thinking'],
  session: true,
  async run(ctx, args, _name, snapshot) {
    const current = snapshot.provider_route;
    if (!current || current.provider === 'salaam-proof')
      throw new Error('Choose a live provider/model first with /model.');
    const choose = (level: string) =>
      ctx.applyRoute(
        providerRoute(
          current.provider,
          current.model,
          current.max_tokens,
          current.workspace_id,
          current.connection,
          level as ReasoningLevel,
        ),
      );
    if (args) await choose(args);
    else
      ctx.choice(
        'Reasoning · current ' + (current.reasoning ?? 'automatic low'),
        REASONING_LEVELS.map((level) => ({ value: level, label: level })),
        (level) => void ctx.execute(() => choose(level)),
      );
  },
};

export const MODEL_COMMANDS: readonly SlashCommand[] = [
  modelCommand,
  providerCommand,
  thinkingCommand,
];
