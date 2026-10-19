import { randomUUID } from 'node:crypto';
import { digest, canonical, ServiceError } from './protocol.js';
import { a2aIdentity, a2aObject, type A2AObject } from './a2a-peer.js';

export interface A2ACheckpoint {
  schema_version: 1;
  dialect: 'a2a';
  run_id?: string;
  worker_id: string;
  attempt_id: string;
  peer_id: string;
  peer_digest: string;
  tenant: string;
  message_id: string;
  task_id: string | null;
  context_id: string | null;
  state: 'prepared' | 'dispatching' | 'running' | 'terminal' | 'unknown';
  prompt_digest: string;
  cancel_requested: boolean;
  cancel_state?: 'intent' | 'dispatching' | 'acknowledged' | 'unsupported';
  result: A2AObject | null;
  disclosure: { path: string; digest: string; bytes: number }[];
  progress?: { remote_state: string | null; artifact_ids: string[] };
  artifact_receipts?: { id: string; content_digest: string; upstream_ids: string[] }[];
}
export interface A2ARpc {
  rpc(method: 'SendMessage' | 'GetTask' | 'CancelTask', params: A2AObject): Promise<A2AObject>;
}
export const A2A_TERMINAL = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);
const STATES = new Set([
  ...A2A_TERMINAL,
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);
export function a2aTask(value: unknown): A2AObject {
  const task = a2aObject(value);
  a2aIdentity(task.id);
  a2aIdentity(task.contextId);
  const status = a2aObject(task.status);
  if (!STATES.has(status.state) || canonical(task).length > 524288)
    throw new ServiceError('a2a_task', 'Unsupported task state or size');
  const artifacts = task.artifacts ?? [],
    ids = new Set<string>();
  if (!Array.isArray(artifacts) || artifacts.length > 64) throw Error('Unbounded remote artifacts');
  for (const artifact of artifacts) {
    const id = a2aIdentity(a2aObject(artifact).artifactId);
    if (ids.has(id)) throw Error('Duplicate remote artifact identity');
    ids.add(id);
    validateParts(artifact.parts);
  }
  // Remote URIs are never fetched, even if authenticated or advertised as files.
  for (const message of task.history ?? []) {
    if (!['ROLE_AGENT', 'ROLE_USER'].includes(message.role))
      throw Error('Unknown remote message role');
    validateParts(message.parts);
  }
  if (status.message) validateParts(status.message.parts);
  return structuredClone(task);
}
export function validateParts(value: unknown): void {
  if (!Array.isArray(value) || value.length > 64) throw Error('Unsupported remote parts');
  for (const raw of value) {
    const p = a2aObject(raw),
      keys = Object.keys(p).filter((k) => !['metadata', 'mediaType'].includes(k));
    if (
      keys.length !== 1 ||
      !['text', 'data'].includes(keys[0]!) ||
      (keys[0] === 'text' && typeof p.text !== 'string') ||
      (keys[0] === 'data' && (!p.data || typeof p.data !== 'object' || Array.isArray(p.data)))
    )
      throw Error('Only bounded inline text/data parts are admitted');
    if (
      p.mediaType !== undefined &&
      p.mediaType !== (keys[0] === 'text' ? 'text/plain' : 'application/json')
    )
      throw Error('Unsupported inline part media type');
    if (canonical(p).length > 131072) throw Error('Remote part exceeds bound');
  }
}
function terminalContent(task: A2AObject): unknown {
  return {
    id: task.id,
    contextId: task.contextId,
    status: {
      state: task.status.state,
      message: task.status.message
        ? {
            role: task.status.message.role,
            parts: task.status.message.parts,
            metadata: task.status.message.metadata ?? null,
          }
        : null,
    },
    artifacts: (task.artifacts ?? []).map(({ artifactId: _, ...content }: A2AObject) => content),
    metadata: task.metadata ?? null,
  };
}
/** Dispatch is never retried. Reconnect reads only the saved peer/task/context. */
export class A2AInvocation {
  private cp: A2ACheckpoint;
  private broken = false;
  constructor(
    readonly peer: { id: string; tenant: string; digest: string; cancel: boolean; skill: string },
    checkpoint: A2ACheckpoint,
    readonly rpc: A2ARpc,
    readonly save: (value: A2ACheckpoint) => undefined,
  ) {
    if (
      checkpoint.dialect !== 'a2a' ||
      checkpoint.schema_version !== 1 ||
      checkpoint.peer_id !== peer.id ||
      checkpoint.peer_digest !== peer.digest ||
      checkpoint.tenant !== peer.tenant
    )
      throw Error('A2A peer ownership changed');
    this.cp = structuredClone(checkpoint);
    if (['dispatching', 'running'].includes(this.cp.state)) this.update({ state: 'unknown' });
  }
  view(): A2ACheckpoint {
    return structuredClone(this.cp);
  }
  private update(change: Partial<A2ACheckpoint>): void {
    if (this.broken) throw Error('A2A checkpoint control failed');
    const next = { ...this.cp, ...change };
    try {
      if (this.save(structuredClone(next)) !== undefined)
        throw Error('A2A checkpoint must commit synchronously');
    } catch (e) {
      this.broken = true;
      throw e;
    }
    this.cp = next;
  }
  private accept(value: unknown): A2AObject {
    const task = a2aTask(value);
    if (
      (this.cp.task_id && task.id !== this.cp.task_id) ||
      (this.cp.context_id && task.contextId !== this.cp.context_id)
    )
      throw Error('Remote task/context ownership mismatch');
    if (
      this.cp.state === 'terminal' &&
      digest(terminalContent(task)) !== digest(terminalContent(this.cp.result!))
    )
      throw Error('Conflicting remote terminal snapshot');
    const artifact_receipts = (task.artifacts ?? []).map((artifact: A2AObject, index: number) => {
      const { artifactId, ...content } = artifact,
        content_digest = digest(content),
        id = digest({ task_id: task.id, index, content_digest });
      const old = this.cp.artifact_receipts?.find((a) => a.id === id);
      return {
        id,
        content_digest,
        upstream_ids: [...new Set([...(old?.upstream_ids ?? []), artifactId])].slice(
          -8,
        ) as string[],
      };
    });
    this.update({
      task_id: task.id,
      context_id: task.contextId,
      result: task,
      artifact_receipts,
      state: A2A_TERMINAL.has(task.status.state) ? 'terminal' : 'running',
    });
    return task;
  }
  async dispatch(text: string, data: A2AObject): Promise<A2AObject> {
    if (
      this.cp.state !== 'prepared' ||
      this.cp.cancel_requested ||
      this.cp.prompt_digest !== digest({ text, data })
    )
      throw Error('A2A invocation cannot dispatch again');
    this.update({ state: 'dispatching' });
    try {
      const result = await this.rpc.rpc('SendMessage', {
        message: {
          messageId: this.cp.message_id,
          role: 'ROLE_USER',
          parts: [{ text }, { data }],
          metadata: { 'salaam.skill': this.peer.skill },
        },
        configuration: {
          acceptedOutputModes: ['text/plain', 'application/json'],
          returnImmediately: true,
          historyLength: 0,
        },
      });
      if (!result.task || result.message) throw Error('A durable remote task receipt is required');
      return this.accept(result.task);
    } catch (e) {
      this.update({ state: 'unknown' });
      throw e;
    }
  }
  async inspect(): Promise<A2AObject> {
    if (!this.cp.task_id || !this.cp.context_id || this.broken)
      throw Error('Remote acceptance identity is unknown; prompt will not be resent');
    const result = await this.rpc.rpc('GetTask', { id: this.cp.task_id, historyLength: 0 });
    return this.accept(result);
  }
  /** Stream chunks are tentative. Reconnect always reconciles an authoritative task snapshot. */
  observe(raw: unknown): void {
    const event = a2aObject(raw),
      keys = Object.keys(event);
    if (keys.length !== 1 || !['task', 'statusUpdate', 'artifactUpdate'].includes(keys[0]!))
      throw new ServiceError('a2a_identity', 'Unsupported stream payload');
    const value = a2aObject(event[keys[0]!]);
    if (
      (keys[0] === 'task' ? value.id : value.taskId) !== this.cp.task_id ||
      value.contextId !== this.cp.context_id
    )
      throw new ServiceError('a2a_identity', 'Unowned stream task/context');
    const progress = structuredClone(this.cp.progress ?? { remote_state: null, artifact_ids: [] });
    if (keys[0] === 'task') {
      const task = a2aTask(value);
      progress.remote_state = task.status.state;
      progress.artifact_ids = task.artifacts?.map((a: A2AObject) => a.artifactId) ?? [];
    } else if (keys[0] === 'statusUpdate') {
      if (!STATES.has(value.status?.state))
        throw new ServiceError('a2a_identity', 'Unknown stream state');
      progress.remote_state = value.status.state;
    } else {
      a2aIdentity(value.artifact?.artifactId);
      validateParts(value.artifact.parts);
      if (!progress.artifact_ids.includes(value.artifact.artifactId))
        progress.artifact_ids.push(value.artifact.artifactId);
      if (progress.artifact_ids.length > 64)
        throw new ServiceError('a2a_identity', 'Unbounded stream artifacts');
    }
    if (this.cp.state !== 'terminal') this.update({ progress });
  }
  async cancel(): Promise<void> {
    if (this.cp.state === 'terminal') return;
    this.update({ cancel_requested: true, cancel_state: 'intent' });
    if (!this.cp.task_id) throw Error('Unknown remote acceptance cannot be canceled safely');
    await this.inspect();
    if (this.view().state === 'terminal') return;
    if (!this.peer.cancel) {
      this.update({ cancel_state: 'unsupported' });
      if (this.view().state !== 'terminal')
        throw Error('Peer cancellation is unsupported; remote stop remains unconfirmed');
      return;
    }
    this.update({ cancel_state: 'dispatching' });
    const task = await this.rpc.rpc('CancelTask', { id: this.cp.task_id });
    this.accept(task);
    this.update({ cancel_state: 'acknowledged' });
    if (this.view().state !== 'terminal')
      throw Error('Cancellation acknowledgement does not confirm remote stop');
  }
  static prepare(
    worker: string,
    attempt: string,
    peer: { id: string; tenant: string; digest: string },
    text: string,
    data: A2AObject,
    disclosure: A2ACheckpoint['disclosure'],
  ): A2ACheckpoint {
    return {
      schema_version: 1,
      dialect: 'a2a',
      worker_id: worker,
      attempt_id: attempt,
      peer_id: peer.id,
      peer_digest: peer.digest,
      tenant: peer.tenant,
      message_id: randomUUID(),
      task_id: null,
      context_id: null,
      state: 'prepared',
      prompt_digest: digest({ text, data }),
      cancel_requested: false,
      result: null,
      disclosure,
    };
  }
}
