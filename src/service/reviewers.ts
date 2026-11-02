// The host's optional command reviewers (Phase 4c): the configured options, the config's default
// and a host pin, and which one a session uses.
import type { DangerClassifier } from '../local/index.js';
import type { Store } from '../store/index.js';

export class CommandReviewers {
  readonly options = new Map<string, DangerClassifier>();
  default = 'off';
  pin?: string;

  /** The reviewer a session uses: the host's pin, else its own choice, else the config default. */
  choice(store: Store, session: string): string {
    if (this.pin) return this.pin;
    const row = store.db
      .prepare('SELECT choice FROM danger_classifier_choice WHERE session_id=?')
      .get(session) as { choice: string } | undefined;
    const choice = row?.choice ?? this.default;
    return choice === 'off' || this.options.has(choice) ? choice : 'off';
  }

  /** What the danger-classifier route shows for a session. */
  view(store: Store, session: string) {
    const choice = this.options.size ? this.choice(store, session) : 'off',
      chosen = this.options.get(choice)?.config;
    return {
      configured: this.options.size > 0,
      enabled: !!chosen,
      ...(chosen
        ? {
            provider: chosen.provider,
            model: chosen.model,
            on_unavailable: chosen.on_unavailable,
          }
        : {}),
      choice,
      pinned: this.pin !== undefined,
      options: [...this.options.values()].map(({ config: o }) => ({
        name: o.name,
        provider: o.provider,
        model: o.model,
      })),
    };
  }
}
