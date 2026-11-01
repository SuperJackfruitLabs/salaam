import { HarnessRpc, type HarnessLaunch, type RpcObject } from './rpc.js';
import { digest, ServiceError } from '../core/protocol.js';

export interface HarnessCheckpoint {
  schema_version: 1;
  dialect: 'acp' | 'codex';
  worker_id: string;
  attempt_id: string;
  state: 'prepared' | 'creating' | 'idle' | 'dispatching' | 'running' | 'terminal' | 'unknown';
  session_id: string | null;
  turn_id: string | null;
  prompt_digest: string | null;
  cancel_requested: boolean;
  cancel_state?: 'intent' | 'dispatching' | 'acknowledged';
  result: RpcObject | null;
  load_session: boolean;
}
export interface HarnessProtocolHooks {
  /** Must commit synchronously. A failed save prevents forwarding. */
  save: (checkpoint: HarnessCheckpoint) => undefined;
  permission: (binding: {
    worker_id: string;
    attempt_id: string;
    session_id: string;
    turn_id: string | null;
    method: string;
    params: RpcObject;
  }) => Promise<'approve' | 'deny'>;
  event?: (method: string, params: RpcObject) => void;
  failed?: (error: Error) => void;
}
const identity = (v: unknown): string => {
  if (typeof v !== 'string' || !v.length || v.length > 256)
    throw new ServiceError('harness_identity', 'Missing or invalid upstream identity');
  return v;
};
/** One owned invocation per adapter. Resume inspects the existing identity; it never resubmits a prompt. */
export class HarnessProtocol {
  readonly rpc: HarnessRpc;
  private checkpoint: HarnessCheckpoint;
  private pendingTurns: RpcObject[] = [];
  private terminal?: { resolve: (value: RpcObject) => void; reject: (error: Error) => void };
  private closing = false;
  private failed = false;
  constructor(
    launch: HarnessLaunch,
    checkpoint: HarnessCheckpoint,
    readonly hooks: HarnessProtocolHooks,
  ) {
    if (
      checkpoint.schema_version !== 1 ||
      checkpoint.dialect !== launch.dialect ||
      !checkpoint.worker_id ||
      !checkpoint.attempt_id
    )
      throw new Error('Harness checkpoint ownership mismatch');
    this.checkpoint = structuredClone(checkpoint);
    if (['creating', 'dispatching', 'running'].includes(this.checkpoint.state)) {
      const recovered = { ...this.checkpoint, state: 'unknown' as const };
      const saved: unknown = this.hooks.save(structuredClone(recovered));
      if (saved !== undefined) throw new Error('Harness recovery must commit synchronously');
      this.checkpoint = recovered;
    }
    this.rpc = new HarnessRpc(launch, {
      request: (method, params) => this.permission(method, params),
      notification: (method, params) => this.notification(method, params),
      failed: (error) => {
        if (!this.closing) {
          try {
            this.unknown();
          } finally {
            this.failed = true;
            this.terminal?.reject(error);
            this.hooks.failed?.(error);
          }
        }
      },
    });
  }
  view(): HarnessCheckpoint {
    return structuredClone(this.checkpoint);
  }
  private save(update: Partial<HarnessCheckpoint>): void {
    this.assertUsable();
    const next = { ...this.checkpoint, ...update };
    try {
      const result: unknown = this.hooks.save(structuredClone(next));
      if (result !== undefined)
        throw new Error('Harness checkpoint save must commit synchronously');
    } catch (error) {
      this.failed = true;
      void this.rpc.close();
      try {
        this.hooks.failed?.(error as Error);
      } catch {}
      throw error;
    }
    this.checkpoint = next;
  }
  private assertUsable(): void {
    if (this.failed)
      throw new ServiceError('harness_control_failed', 'Harness control is no longer usable');
  }
  private unknown(): void {
    if (this.failed) return;
    if (!['terminal', 'prepared', 'idle'].includes(this.checkpoint.state))
      this.save({ state: 'unknown' });
  }
  async initialize(gatewayAuth = false): Promise<RpcObject> {
    this.assertUsable();
    const result = await this.rpc.request(
      'initialize',
      this.checkpoint.dialect === 'acp'
        ? {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              ...(gatewayAuth ? { auth: { _meta: { gateway: true } } } : {}),
            },
            clientInfo: { name: 'salaam', version: '0.0.1' },
          }
        : {
            clientInfo: { name: 'salaam', version: '0.0.1' },
            capabilities: { experimentalApi: false },
          },
    );
    if (this.checkpoint.dialect === 'acp') {
      if (result.protocolVersion !== 1)
        throw new ServiceError('harness_protocol_changed', 'ACP v1 negotiation required');
      const caps = result.agentCapabilities as RpcObject | undefined;
      this.save({ load_session: caps?.loadSession === true });
    } else this.rpc.notify('initialized', {});
    return result;
  }
  async create(params: RpcObject): Promise<HarnessCheckpoint> {
    this.assertUsable();
    if (this.checkpoint.state !== 'prepared' || this.checkpoint.session_id)
      throw new ServiceError('harness_replay', 'An owned session intent cannot be recreated');
    this.save({ state: 'creating' });
    try {
      const result = await this.rpc.request(
        this.checkpoint.dialect === 'acp' ? 'session/new' : 'thread/start',
        params,
        30000,
      );
      const id =
        this.checkpoint.dialect === 'acp'
          ? identity(result.sessionId)
          : identity((result.thread as RpcObject)?.id);
      this.save({ session_id: id, state: 'idle' });
      return this.view();
    } catch (error) {
      this.unknown();
      throw error;
    }
  }
  async prompt(text: string): Promise<RpcObject> {
    this.assertUsable();
    if (
      this.checkpoint.state !== 'idle' ||
      !this.checkpoint.session_id ||
      this.checkpoint.prompt_digest
    )
      throw new ServiceError(
        'harness_replay',
        'This invocation already owns a prompt or uncertain work',
      );
    if (!text.trim() || Buffer.byteLength(text) > 65536 || text.trimStart().startsWith('/'))
      throw new Error('Invalid external instruction');
    this.save({ state: 'dispatching', prompt_digest: digest(text) });
    try {
      if (this.checkpoint.dialect === 'acp') {
        const result = await this.rpc.request(
          'session/prompt',
          { sessionId: this.checkpoint.session_id, prompt: [{ type: 'text', text }] },
          180000,
        );
        if (
          !['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(
            String(result.stopReason),
          )
        )
          throw new Error('Unknown ACP terminal stop reason');
        this.save({ state: 'terminal', result });
        return result;
      }
      const done = new Promise<RpcObject>((resolve, reject) => {
        this.terminal = { resolve, reject };
      });
      // Avoid an unhandled rejection if transport failure happens before turn/start returns.
      void done.catch(() => {});
      const result = await this.rpc.request(
        'turn/start',
        { threadId: this.checkpoint.session_id, input: [{ type: 'text', text }] },
        30000,
      );
      const turn = identity((result.turn as RpcObject)?.id);
      this.save({ state: 'running', turn_id: turn });
      for (const notification of this.pendingTurns.splice(0)) this.codexTerminal(notification);
      if (
        this.checkpoint.cancel_requested &&
        this.checkpoint.cancel_state === 'intent' &&
        this.view().state !== 'terminal'
      )
        await this.forwardCancel();
      const timer = setTimeout(() => {
        try {
          this.unknown();
        } catch (error) {
          this.terminal?.reject(error as Error);
          return;
        }
        this.terminal?.reject(
          new ServiceError('harness_outcome_unknown', 'No owned terminal turn receipt'),
        );
      }, 180000);
      try {
        return await done;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      this.unknown();
      throw error;
    }
  }
  async cancel(): Promise<HarnessCheckpoint> {
    this.assertUsable();
    if (!['dispatching', 'running'].includes(this.checkpoint.state) || !this.checkpoint.session_id)
      throw new ServiceError('harness_not_running', 'No running owned prompt');
    if (this.checkpoint.cancel_requested) return this.view();
    this.save({ cancel_requested: true, cancel_state: 'intent' });
    if (this.checkpoint.dialect === 'codex' && !this.checkpoint.turn_id) return this.view();
    await this.forwardCancel();
    return this.view();
  }
  private async forwardCancel(): Promise<void> {
    this.save({ cancel_state: 'dispatching' });
    if (this.checkpoint.dialect === 'acp')
      this.rpc.notify('session/cancel', { sessionId: this.checkpoint.session_id });
    else {
      if (!this.checkpoint.turn_id)
        throw new ServiceError('harness_outcome_unknown', 'Turn acceptance is not yet known');
      await this.rpc.request('turn/interrupt', {
        threadId: this.checkpoint.session_id,
        turnId: this.checkpoint.turn_id,
      });
      this.save({ cancel_state: 'acknowledged' });
    }
    // Acknowledgement is not proof of a terminal turn or stopped tools.
  }
  async inspect(params: RpcObject = {}): Promise<RpcObject> {
    this.assertUsable();
    if (!this.checkpoint.session_id)
      throw new ServiceError('harness_outcome_unknown', 'No accepted upstream session identity');
    if (this.checkpoint.dialect === 'acp') {
      if (this.checkpoint.state === 'unknown')
        throw new ServiceError(
          'harness_outcome_unknown',
          'ACP cannot safely reconcile an uncertain prompt; inspect retained artifacts and resolve explicitly',
        );
      if (!this.checkpoint.load_session)
        throw new ServiceError('harness_resume_unsupported', 'Peer did not admit session loading');
      const result = await this.rpc.request('session/load', {
        ...params,
        sessionId: this.checkpoint.session_id,
      });
      // ACP history loading cannot prove which uncertain prompt completed.
      return result;
    }
    const result = await this.rpc.request('thread/read', {
      threadId: this.checkpoint.session_id,
      includeTurns: true,
    });
    const thread = result.thread as RpcObject;
    if (identity(thread?.id) !== this.checkpoint.session_id)
      throw new ServiceError('harness_identity', 'Returned thread belongs to another worker');
    if (this.checkpoint.turn_id && Array.isArray(thread.turns)) {
      const turn = thread.turns.find((t: any) => t.id === this.checkpoint.turn_id) as
        RpcObject | undefined;
      if (turn && ['completed', 'failed', 'interrupted'].includes(String(turn.status)))
        this.save({ state: 'terminal', result: { turn } });
    }
    return result;
  }
  private async permission(method: string, params: RpcObject): Promise<unknown> {
    this.assertUsable();
    const state = this.checkpoint;
    if (
      !state.session_id ||
      state.cancel_requested ||
      !['dispatching', 'running'].includes(state.state)
    )
      throw new ServiceError('harness_permission_denied', 'No active owned invocation');
    if (state.dialect === 'acp') {
      if (method !== 'session/request_permission' || params.sessionId !== state.session_id)
        throw new ServiceError('harness_permission_denied', 'Client method or session is unowned');
      identity((params.toolCall as RpcObject)?.toolCallId);
    } else {
      if (
        !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
          method,
        ) ||
        params.threadId !== state.session_id ||
        !state.turn_id ||
        params.turnId !== state.turn_id
      )
        throw new ServiceError('harness_permission_denied', 'Approval thread or turn is unowned');
      identity(params.itemId);
    }
    const decision = await this.hooks.permission({
      worker_id: state.worker_id,
      attempt_id: state.attempt_id,
      session_id: state.session_id,
      turn_id: state.turn_id,
      method,
      params,
    });
    this.assertUsable();
    if (
      this.checkpoint.cancel_requested ||
      !['dispatching', 'running'].includes(this.checkpoint.state)
    )
      throw new ServiceError(
        'harness_permission_denied',
        'Owned invocation stopped before the decision',
      );
    if (decision !== 'approve' && decision !== 'deny')
      throw new ServiceError('harness_permission_denied', 'Invalid local permission decision');
    if (state.dialect === 'acp') {
      const options = Array.isArray(params.options) ? (params.options as RpcObject[]) : [];
      const option = options.find(
        (o) => o.kind === (decision === 'approve' ? 'allow_once' : 'reject_once'),
      );
      if (!option || typeof option.optionId !== 'string')
        throw new ServiceError(
          'harness_permission_denied',
          'Peer lacks a once-only permission choice',
        );
      return { outcome: { outcome: 'selected', optionId: option.optionId } };
    }
    return { decision: decision === 'approve' ? 'accept' : 'decline' };
  }
  private notification(method: string, params: RpcObject): void {
    const state = this.checkpoint;
    if (state.dialect === 'acp' && method === 'session/update') {
      if (params.sessionId !== state.session_id) {
        if (state.state === 'creating') return;
        throw new ServiceError('harness_identity', 'Unowned ACP update');
      }
      if (state.state === 'dispatching') this.save({ state: 'running' });
    } else if (state.dialect === 'codex' && method.startsWith('turn/')) {
      if (params.threadId !== state.session_id)
        throw new ServiceError('harness_identity', 'Unowned Codex thread notification');
      if (method === 'turn/completed') {
        if (!state.turn_id && state.state === 'dispatching') {
          if (this.pendingTurns.length >= 16) throw Error('Unaccepted turn event bound');
          this.pendingTurns.push(params);
        } else this.codexTerminal(params);
      }
    }
    this.hooks.event?.(method, params);
  }
  private codexTerminal(params: RpcObject): void {
    const turn = params.turn as RpcObject;
    if (
      params.threadId !== this.checkpoint.session_id ||
      identity(turn?.id) !== this.checkpoint.turn_id
    )
      throw new ServiceError('harness_identity', 'Terminal receipt belongs to another turn');
    if (!['completed', 'failed', 'interrupted'].includes(String(turn.status)))
      throw new Error('Nonterminal Codex completion');
    const result = { turn };
    if (this.checkpoint.state === 'terminal') {
      if (digest(this.checkpoint.result) !== digest(result))
        throw new Error('Conflicting terminal receipt');
      return;
    }
    this.save({ state: 'terminal', result });
    this.terminal?.resolve(result);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.unknown();
    await this.rpc.close();
  }
}
