// Requests to reviewed integrations: the operator's declared MCP servers (through a per-host
// breaker), the native Toolkit, and the station's managed MCP servers.
import { ServiceError, digest, string } from '../../core/index.js';
import type { Store } from '../../store/index.js';
import type { ManagedWork } from '../../execution/index.js';
import type { McpWork, OperatorMcp } from '../../mcp/index.js';
import type { ToolkitWork } from '../../toolkit/index.js';
import type { ChildWork } from '../../workers/index.js';
import { callThroughBreaker, type HostBreaker } from '../breaker.js';
import type { BridgeRequest } from './bridge.js';

export interface IntegrationDeps {
  readonly store: Store;
  readonly children?: ChildWork;
  readonly managed?: ManagedWork;
  readonly mcp?: McpWork;
  readonly operatorMcp?: OperatorMcp;
  readonly toolkit?: ToolkitWork;
  readonly fetchBreaker: HostBreaker;
  declaredMcp(id: string): boolean;
  assertActive(id: string, epoch: number, attempt: string): void;
}

export class IntegrationHandlers {
  constructor(private readonly s: IntegrationDeps) {}

  /** operator_mcp.*: the operator's declared MCP servers. */
  async operatorMcp({ id, method, body, w }: BridgeRequest): Promise<unknown> {
    if (!this.s.declaredMcp(id) || !w.operatorMcp || !w.attempt)
      throw new ServiceError('mcp_disabled', 'Worker has no declared MCP servers', 403);
    this.s.assertActive(id, w.epoch, w.attempt);
    if (method === 'operator_mcp.catalog')
      return await this.s.operatorMcp!.catalog(id, body.server, body.tool);
    if (method !== 'operator_mcp.call')
      throw new ServiceError('invalid_field', 'Unknown declared MCP method', 400);
    const attempt = w.attempt;
    const args = body.arguments ?? {};
    const server = String(body.server ?? ''),
      tool = String(body.tool ?? '');
    // A host failing again and again is paused briefly (never called, so no operator MCP call
    // is recorded); the agent gets a tool error and the run carries on.
    return await callThroughBreaker(
      this.s.fetchBreaker,
      id,
      args,
      (paused) =>
        this.s.store.transaction(() =>
          this.s.store.event(id, 'fetch.host_paused', { attempt_id: attempt, ...paused }),
        ),
      async () => {
        try {
          const result = await this.s.operatorMcp!.call(id, body.server, body.tool, args);
          this.s.store.transaction(() =>
            this.s.store.event(id, 'operator_mcp.call', {
              attempt_id: attempt,
              server,
              tool,
              argument_digest: digest(args),
              outcome: result.is_error ? 'tool_error' : 'returned',
              result_digest: digest(result),
            }),
          );
          return result;
        } catch (error) {
          this.s.store.transaction(() =>
            this.s.store.event(id, 'operator_mcp.call', {
              attempt_id: attempt,
              server,
              tool,
              argument_digest: digest(args),
              outcome: 'failed',
              error: (error as ServiceError).code ?? 'mcp_server_failed',
            }),
          );
          throw error;
        }
      },
    );
  }

  /** toolkit.*: the native Toolkit catalog and calls. */
  toolkit({ id, method, body, w }: BridgeRequest): unknown {
    if (!this.s.toolkit || !w.toolkit || !w.attempt || this.s.children?.owned(id))
      throw new ServiceError('toolkit_disabled', 'Worker has no native Toolkit authority', 403);
    this.s.assertActive(id, w.epoch, w.attempt);
    this.s.toolkit.assertBinding(id, w.toolkit);
    this.s.store.taskGrantCheck?.(id);
    if (method === 'toolkit.catalog')
      return this.s.toolkit.catalog(
        id,
        w.toolkit,
        body.category === undefined ? undefined : string(body.category, 'category', 128),
        body.action === undefined ? undefined : string(body.action, 'action', 128),
      );
    if (!['toolkit.prepare', 'toolkit.run', 'toolkit.status'].includes(method))
      throw new ServiceError('invalid_field', 'Unsupported native Toolkit action', 400);
    const call =
      method === 'toolkit.prepare'
        ? this.s.toolkit.prepare(
            id,
            w.epoch,
            w.attempt,
            string(body.tool_call_id, 'tool_call_id', 512),
            body.args,
          )
        : this.s.toolkit.calls.get(string(body.call_id, 'call_id', 128));
    if (call.session_id !== id || call.worker_epoch !== w.epoch || call.attempt_id !== w.attempt)
      throw new ServiceError(
        'mcp_call_scope',
        'Native Toolkit call belongs to another invocation',
        403,
      );
    if (method === 'toolkit.run') this.s.toolkit.start(call.id, id, w.epoch, w.attempt);
    return this.s.toolkit.view(call.id);
  }

  /** mcp.*: the station's managed MCP servers. */
  mcp({ id, method, body, w }: BridgeRequest): unknown {
    if (!this.s.mcp || !w.mcp || !w.attempt || this.s.children?.owned(id))
      throw new ServiceError('mcp_disabled', 'Worker has no managed MCP authority', 403);
    this.s.assertActive(id, w.epoch, w.attempt);
    this.s.mcp.assertBinding(id, w.mcp);
    this.s.store.taskGrantCheck?.(id);
    if (method === 'mcp.catalog')
      return this.s.mcp.describe(
        id,
        w.mcp,
        body.server === undefined ? undefined : string(body.server, 'server', 128),
        body.tool === undefined ? undefined : string(body.tool, 'tool', 128),
      );
    const call =
      method === 'mcp.prepare'
        ? this.s.mcp.prepare(
            id,
            w.epoch,
            w.attempt,
            string(body.tool_call_id, 'tool_call_id', 512),
            body.args,
          )
        : this.s.mcp.get(string(body.call_id, 'call_id', 128));
    if (call.session_id !== id || call.worker_epoch !== w.epoch || call.attempt_id !== w.attempt)
      throw new ServiceError('mcp_call_scope', 'MCP call belongs to another invocation', 403);
    if (!['mcp.prepare', 'mcp.run', 'mcp.status'].includes(method))
      throw new ServiceError('invalid_field', 'Unsupported MCP action', 400);
    const current = method === 'mcp.run' ? this.s.mcp.start(call.id, id, w.epoch, w.attempt) : call;
    return {
      call: current,
      result: current.result_artifact
        ? JSON.parse(this.s.mcp.artifacts.read(current.result_artifact))
        : null,
      ...(current.operation_id && this.s.managed
        ? {
            operation: this.s.managed.operation(current.operation_id),
            approval: this.s.managed.forOperation(current.operation_id),
          }
        : {}),
    };
  }
}
