// Requests about the model: provider authentication, model request admission and usage.
import {
  canonical,
  credentialStrings,
  digest,
  object,
  string,
  textDigest,
  type ProviderRoute,
} from '../../core/index.js';
import { validateProviderPayload } from '../../providers/index.js';
import type { Store } from '../../store/index.js';
import type { ChildWork } from '../../workers/index.js';
import type { CodingWork } from '../../coding/index.js';
import type { TaskContext } from '../task-context.js';
import type { BridgeRequest } from './bridge.js';

export interface ProviderDeps {
  readonly store: Store;
  readonly children?: ChildWork;
  readonly coding?: CodingWork;
  readonly tasks: TaskContext;
  /** The service's own provider route, which root sessions use. */
  readonly route: ProviderRoute;
  /** Whether the service's provider authentication enforces an output cap. */
  readonly outputCap: boolean;
  providerAuth(): Promise<unknown>;
  prepareProviderRoute(
    route: ProviderRoute,
  ): Promise<{ route: ProviderRoute; output_cap: boolean; auth: unknown }>;
  assertSessionProviderSupported(id: string, outputCap?: boolean): void;
  tools(id: string): string[];
}

export class ProviderHandlers {
  constructor(private readonly s: ProviderDeps) {}

  /** provider.auth: the credentials for the admitted route of the worker. */
  async auth({ id, w }: BridgeRequest): Promise<unknown> {
    const route = w.route;
    if (!this.s.children?.owned(id) && !this.s.store.localWorkspace(id)) {
      const auth = await this.s.providerAuth();
      if (canonical(this.s.route) !== canonical(route)) throw new Error('Provider route changed');
      w.providerOutputCap = this.s.outputCap;
      this.s.assertSessionProviderSupported(id, this.s.outputCap);
      return auth;
    }
    const prepared = await this.s.prepareProviderRoute(route);
    const expectedCap = this.s.children?.owned(id)
      ? this.s.store.workerBoundary.view(this.s.children.owned(id)!.id).binding.agent?.output_cap
      : (this.s.store.localOutputCap(id) ?? this.s.outputCap);
    if (
      canonical(prepared.route) !== canonical(route) ||
      (expectedCap ?? this.s.outputCap) !== prepared.output_cap
    )
      throw new Error('Provider capability or route changed; restart or renew admission');
    w.providerOutputCap = prepared.output_cap;
    this.s.assertSessionProviderSupported(id, prepared.output_cap);
    const auth = prepared.auth;
    w.secrets = [...new Set([...(w.secrets ?? []), ...credentialStrings(auth)])];
    return auth;
  }

  /** usage: the provider-reported usage of an admitted request. */
  usage({ id, body, w }: BridgeRequest): unknown {
    const route = w.route;
    const source = this.s.store.db
      .prepare('SELECT session_id,attempt_id FROM usage_observations WHERE source_key=?')
      .get(String(body.source_key));
    if (!source || source.session_id !== id || source.attempt_id !== (w.attempt ?? null))
      throw new Error('Usage does not belong to this request');
    this.s.store.transaction(() =>
      this.s.store.usage.observe(
        id,
        string(body.source_key, 'source_key', 256),
        route.provider,
        route.model,
        body.usage,
        route.provider !== 'salaam-proof' ? 'estimated' : 'known',
      ),
    );
    return { ok: true };
  }

  /** model: admit one model request against the task frame and policy. */
  model({ id, body, w }: BridgeRequest): unknown {
    const route = w.route;
    this.s.coding?.assertSafe(id);
    this.s.store.taskGrantCheck?.(id);
    if (
      body.provider !== route.provider ||
      body.model !== route.model ||
      body.context_digest !== textDigest(this.s.tasks.frame(id, w.binding))
    )
      throw new Error('Provider or task context is invalid');
    if (route.provider !== 'salaam-proof') {
      if (w.providerOutputCap === undefined)
        throw new Error('Provider authentication was not admitted');
      this.s.assertSessionProviderSupported(id, w.providerOutputCap);
      validateProviderPayload(
        body.payload,
        route,
        this.s.tasks.frame(id, w.binding),
        this.s.tools(id),
        !w.providerOutputCap,
      );
      if (body.payload_digest !== digest(body.payload))
        throw new Error('Provider payload digest changed');
    }
    if (route.provider === 'salaam-proof') {
      const payload = object(body.payload);
      if (!Array.isArray(payload.messages)) throw new Error('Proof payload missing');
      const last = object(payload.messages.at(-1));
      const text =
        typeof last.content === 'string'
          ? last.content
          : Array.isArray(last.content)
            ? last.content.map((x) => (object(x).type === 'text' ? object(x).text : '')).join('')
            : '';
      if (
        last.role !== 'user' ||
        text !== this.s.tasks.frame(id, w.binding) ||
        body.payload_digest !== digest(payload)
      )
        throw new Error('Proof task payload is stale or invalid');
    }
    this.s.store.usage.admit(
      id,
      w.attempt,
      string(body.source_key, 'source_key', 256),
      String(body.provider),
      String(body.model),
      { input: Buffer.byteLength(JSON.stringify(body.payload)), output: route.max_tokens },
    );
    this.s.store.transaction(() => {
      this.s.store.event(id, 'model.admitted', {
        attempt_id: w.attempt ?? null,
        epoch: w.epoch,
        provider: body.provider,
        context_digest: body.context_digest,
        context_admission_digest: this.s.tasks.admitted?.currentDigest(id) ?? null,
        payload_digest: body.payload_digest,
        task_version: this.s.tasks.state(id).version,
      });
    });
    return { ok: true };
  }
}
