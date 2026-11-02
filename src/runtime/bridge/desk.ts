// Requests from a person's own local session: web search and fetch, background commands,
// reviewed local edits and commands, and workspace reads. PreToolUse hooks run before each.
import { ServiceError, digest, object, string } from '../../core/index.js';
import type { Store } from '../../store/index.js';
import type { ChildWork } from '../../workers/index.js';
import {
  readLocalWorkspace,
  type HookEvent,
  type HookOutcome,
  type LocalCoding,
} from '../../local/index.js';
import type { SearchKind, WebSearch } from '../../web/index.js';
import type { BridgeRequest } from './bridge.js';

export interface DeskDeps {
  readonly store: Store;
  readonly children?: ChildWork;
  readonly web?: WebSearch;
  readonly localCoding?: LocalCoding;
  assertActive(id: string, epoch: number, attempt: string): void;
  isInteractiveCoding(id: string): boolean;
  preToolUse(
    id: string,
    tool: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ): Promise<void>;
  hook(
    id: string,
    event: HookEvent,
    payload: Record<string, unknown>,
    names?: readonly string[],
  ): Promise<HookOutcome | null>;
}

export class DeskHandlers {
  constructor(private readonly s: DeskDeps) {}

  /** web.search and web.fetch: built-in web search and page reads. */
  async web({ id, method, body, w }: BridgeRequest): Promise<unknown> {
    if (!this.s.web || !this.s.store.localCoding(id) || this.s.children?.owned(id) || !w.attempt)
      throw new ServiceError('web_denied', 'Web search is not admitted for this session', 403);
    this.s.assertActive(id, w.epoch, w.attempt);
    const args = object(body.args);
    const toolCallId = string(body.tool_call_id, 'tool_call_id', 512);
    await this.s.preToolUse(
      id,
      method === 'web.search' ? 'salaam_web_search' : 'salaam_web_fetch',
      args,
      toolCallId,
    );
    if (method === 'web.search') {
      const out = await this.s.web.search({
        query: string(args.query, 'query', 300),
        ...(typeof args.kind === 'string' ? { kind: args.kind as SearchKind } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      });
      // Recorded: kind, backends tried, which answered and how long. Never a key or the query.
      this.s.store.transaction(() =>
        this.s.store.event(id, 'web.search', {
          attempt_id: w.attempt,
          tool_call_id: toolCallId,
          kind: out.kind,
          cached: !!out.cached,
          results: out.results.length,
          tried: out.tried,
        }),
      );
      return out;
    }
    const url = string(args.url, 'url', 2000);
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* fetchPage refuses it */
    }
    try {
      const page = await (await import('../../web/fetch.js')).fetchPage(url);
      this.s.store.transaction(() =>
        this.s.store.event(id, 'web.fetch', {
          attempt_id: w.attempt,
          tool_call_id: toolCallId,
          host,
          status: page.status,
          chars: page.text.length,
          truncated: page.truncated,
        }),
      );
      const { renderFetched } = await import('../../web/fetch.js');
      return { ok: true, url: page.url, text: renderFetched(page) };
    } catch (error) {
      const message = String((error as Error).message ?? error).slice(0, 300);
      this.s.store.transaction(() =>
        this.s.store.event(id, 'web.fetch', {
          attempt_id: w.attempt,
          tool_call_id: toolCallId,
          host,
          error: message,
        }),
      );
      return { ok: false, url, error: message };
    }
  }

  /** bgtask.*: the session's background commands. */
  backgroundTask({ id, method, body, w }: BridgeRequest): unknown {
    if (!this.s.localCoding || !this.s.isInteractiveCoding(id) || !w.attempt)
      throw new ServiceError('background_denied', 'Background commands are not admitted', 403);
    this.s.assertActive(id, w.epoch, w.attempt);
    if (method === 'bgtask.list') return { tasks: this.s.localCoding.tasks(id) };
    const task = string(body.task_id, 'task_id', 64);
    if (method === 'bgtask.output') return this.s.localCoding.taskOutput(id, task);
    if (method === 'bgtask.stop') return this.s.localCoding.stopTask(id, task);
    throw new ServiceError('invalid_field', 'Unsupported background task method');
  }

  /** local.* (all but local.read): reviewed local edits and commands. */
  async local({ id, method, body, w }: BridgeRequest): Promise<unknown> {
    if (
      !this.s.localCoding ||
      !this.s.store.localCoding(id) ||
      this.s.children?.owned(id) ||
      !w.attempt
    )
      throw new ServiceError('local_denied', 'Local coding is not admitted', 403);
    this.s.assertActive(id, w.epoch, w.attempt);
    if (method === 'local.prepare') {
      const toolCall = string(body.tool_call_id, 'tool_call_id', 512);
      const args = object(body.args);
      // A retried prepare returns the recorded call; its hooks already ran.
      const fresh = !this.s.localCoding.hasCall(id, w.epoch, toolCall);
      if (fresh) await this.s.preToolUse(id, 'salaam_local', args, toolCall);
      const prepared = await this.s.localCoding.prepareReviewed(
        id,
        w.epoch,
        w.attempt,
        toolCall,
        args,
      );
      if (fresh && prepared.approval?.state === 'pending')
        void this.s
          .hook(id, 'Notification', {
            notification_type: 'permission_prompt',
            message: `Salaam needs your approval for a ${String(args.action ?? 'local')} request`,
          })
          .catch(() => {});
      return prepared;
    }
    const c = this.s.localCoding.get(string(body.call_id, 'call_id'));
    if (c.session_id !== id || c.epoch !== w.epoch || c.attempt_id !== w.attempt)
      throw new ServiceError('local_scope', 'Operation belongs to another invocation', 403);
    if (method === 'local.run') return this.s.localCoding.run(c.id);
    if (method === 'local.status') return this.s.localCoding.view(c.id);
    throw new ServiceError('invalid_field', 'Unsupported local method');
  }

  /** local.read: read the local workspace. */
  async workspaceRead({ id, body, w }: BridgeRequest): Promise<unknown> {
    if (!this.s.store.localWorkspace(id) || this.s.children?.owned(id) || !w.attempt)
      throw new ServiceError('workspace_denied', 'Local workspace is not admitted', 403);
    this.s.assertActive(id, w.epoch, w.attempt);
    this.s.store.taskGrantCheck?.(id);
    const args = object(body.args);
    await this.s.preToolUse(
      id,
      'salaam_workspace',
      args,
      string(body.tool_call_id, 'tool_call_id', 512),
    );
    const result = readLocalWorkspace(this.s.store.session(id).cwd, args);
    this.s.store.transaction(() =>
      this.s.store.event(id, 'workspace.read', {
        attempt_id: w.attempt,
        tool_call_id: string(body.tool_call_id, 'tool_call_id', 512),
        argument_digest: digest(args),
        result_digest: digest(result),
      }),
    );
    return result;
  }
}
