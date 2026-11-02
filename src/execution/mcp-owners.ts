// The controllers that own MCP and workspace permissions: who may execute a permission and who may
// settle its outcome. Ownership comes from each controller's durable records, never a tool target.
import { ServiceError, type Operation } from '../core/index.js';

export interface McpPermissionController {
  owns(operation: Operation): boolean;
  assert(operation: Operation): void;
  assertSettled(operation: Operation): void;
}
export interface OperationResolution {
  kind: 'operation-resolution';
  id: string;
  revision: number;
  binding: string;
  outcome: 'succeeded' | 'failed_definite';
  evidence: string;
}
/** Historical operator settlement is separate from execution permission. It
 * cannot be used by fresh() or takePermission(), including after a restart. */
export interface McpResolutionController {
  owns(operation: Operation): boolean;
  assertResolution(operation: Operation, request: string, input: OperationResolution): void;
}
/** The legacy trusted controller seam, read when a permission is checked (it may be set late). */
export interface LegacyMcpSeam {
  assertMcpOperation?: (operation: Operation) => void;
  assertMcpSettlement?: (operation: Operation) => void;
}

const CONTROLLER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export class McpOwners {
  private controllers = new Map<string, Readonly<McpPermissionController>>();
  private resolvers = new Map<string, Readonly<McpResolutionController>>();
  constructor(private readonly legacy: LegacyMcpSeam) {}
  get size(): number {
    return this.controllers.size;
  }
  register(name: string, controller: McpPermissionController): () => void {
    if (!CONTROLLER_NAME.test(name) || this.controllers.has(name) || this.legacy.assertMcpOperation)
      throw Error('MCP execution controller already registered or invalid');
    const registered = Object.freeze({ ...controller });
    this.controllers.set(name, registered);
    return () => {
      if (this.controllers.get(name) === registered) this.controllers.delete(name);
    };
  }
  controller(op: Operation): Readonly<McpPermissionController> {
    if (this.controllers.size && this.legacy.assertMcpOperation)
      throw new ServiceError('mcp_owner_unavailable', 'MCP controller registration conflicts');
    const owners = [...this.controllers.values()].filter((owner) => owner.owns(op));
    const [only] = owners;
    if (owners.length === 1 && only) return only;
    if (owners.length === 0 && this.controllers.size === 0 && this.legacy.assertMcpOperation)
      return {
        owns: () => true,
        assert: this.legacy.assertMcpOperation,
        assertSettled:
          this.legacy.assertMcpSettlement ??
          (() => {
            throw new ServiceError(
              'mcp_resources_unconfirmed',
              'MCP resource settlement is unavailable',
            );
          }),
      };
    throw new ServiceError('mcp_owner_unavailable', 'MCP permission has no unique execution owner');
  }
  registerResolution(name: string, controller: McpResolutionController): () => void {
    if (!CONTROLLER_NAME.test(name) || this.resolvers.has(name))
      throw Error('MCP resolution controller already registered or invalid');
    const registered = Object.freeze({ ...controller });
    this.resolvers.set(name, registered);
    return () => {
      if (this.resolvers.get(name) === registered) this.resolvers.delete(name);
    };
  }
  assertResolution(op: Operation, request: string, input: OperationResolution): void {
    const owners = [...this.resolvers.values()].filter((owner) => owner.owns(op));
    const [only] = owners;
    if (owners.length === 1 && only) {
      only.assertResolution(op, request, input);
      return;
    }
    if (owners.length)
      throw new ServiceError(
        'mcp_owner_unavailable',
        'MCP resolution has no unique settlement owner',
      );
    this.controller(op).assertSettled(op);
  }
  clear(): void {
    this.controllers.clear();
  }
}
