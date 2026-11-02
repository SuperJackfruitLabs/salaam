import { PI_PROVIDERS, type ProviderRoute } from '../../core/index.js';
import { providerRoute } from '../../providers/index.js';
import { modelLabel } from '../view.js';
import type { RouteContext } from './context.js';

// /model and /provider: the pinned catalog, and the switch to the chosen route.

/** Interactive sessions switch in place between turns; otherwise the choice opens a new session. */
export async function applyRoute(ctx: RouteContext, route: ProviderRoute): Promise<void> {
  if (ctx.client.snapshot?.provider_route && ctx.client.controlling) {
    try {
      await ctx.client.switchRoute(route);
      ctx.client.notice = 'Now using ' + modelLabel(ctx.client) + ' in this session.';
      return;
    } catch (error) {
      // A route that limits output differently cannot join this session. Keep the choice and
      // open the new session with it, rather than leaving the old model selected.
      if ((error as { code?: string }).code !== 'provider_output_cap_changed') throw error;
      ctx.selectedRoute = route;
      ctx.client.notice = `${route.model ?? route.provider} limits output differently from this session's model, so it starts in a new session. This session stays as it is.`;
      await ctx.newSession();
      return;
    }
  }
  ctx.selectedRoute = route;
  await ctx.newSession();
}
export function modelPicker(ctx: RouteContext): void {
  const configured = (ctx.client.snapshot?.provider_route ?? ctx.client.health?.provider_route)
    ?.provider;
  const live = PI_PROVIDERS.filter((p) => p.getModels().length);
  ctx.choice(
    ctx.client.snapshot ? 'Provider · switches this session' : 'Provider',
    [
      // The configured provider first; the scripted demo last, never the default.
      ...[
        ...live.filter((p) => p.id === configured),
        ...live.filter((p) => p.id !== configured),
      ].map((p) => ({
        value: p.id,
        label: p.name,
        description: p.id + (p.id === configured ? ' · current' : ''),
      })),
      {
        value: 'offline',
        label: 'Offline demo',
        description: 'Scripted fixture, not an AI model',
      },
    ],
    (provider) => {
      if (provider === 'offline') {
        void ctx.execute(() => applyRoute(ctx, providerRoute()));
        return;
      }
      const catalog = PI_PROVIDERS.find((p) => p.id === provider)!;
      ctx.choice(
        'Model · ' + catalog.name,
        catalog.getModels().map((m) => ({
          value: m.id,
          label: m.name,
          description: m.id + ' · ' + m.contextWindow + ' context tokens',
        })),
        (model) => void ctx.execute(() => applyRoute(ctx, providerRoute(provider, model))),
      );
    },
  );
}
