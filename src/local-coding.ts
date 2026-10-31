import { BrokerRelay, COMMAND_NETWORK_PORT } from './command-network.js';
import {
  sandboxArgv,
  seatbeltArgv,
  UNSANDBOXED_REFUSAL,
  type Bwrap,
  type SandboxKind,
  type SandboxLevel,
  type Seatbelt,
} from './command-sandbox.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { classifyCommand, type DangerVerdict } from './command-danger.js';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { ManagedWork } from './managed.js';
import { digest, object, string, ServiceError, type Operation } from './protocol.js';
import {
  prepareLocalEdits,
  verifyLocalEdits,
  applyLocalEdits,
  reviewLocalEdits,
  type LocalEdit,
} from './local-edits.js';
import {
  permissionPolicy,
  autoApprovesEdits,
  autoApprovesCommands,
  permissionDigest,
  assertPermissionBinding,
} from './autonomy.js';
import {
  commandArgv,
  evaluateRules,
  type ApprovalRules,
  type RuleRequest,
} from './approval-rules.js';
import { assertUndoSettled } from './local-undo.js';
import { processIdentity } from './supervisor.js';

const TASK_TAIL = 65536;
const TASK_LIMIT = 4;
const BACKGROUND_LIFETIME = 2 * 3600 * 1000;
type TaskState = 'running' | 'exited' | 'stopped' | 'timed_out' | 'lost';
interface TaskRow {
  id: string;
  session_id: string;
  call_id: string;
  command: string;
  state: TaskState;
  pid: number | null;
  identity: string | null;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
}
interface BackgroundTask {
  id: string;
  session: string;
  done: Promise<void>;
  output: () => { output: string; bytes: number; truncated: boolean };
  stop: (why: TaskState) => void;
}
import {
  applyEditsAsTools,
  killToolGroup,
  serviceToolIdentity,
  toolArgv,
  type ToolIdentity,
} from './tool-identity.js';

interface LocalCall {
  id: string;
  session_id: string;
  attempt_id: string;
  epoch: number;
  tool_call: string;
  input_digest: string;
  root: string;
  args: string;
  operation_id: string;
  state: string;
  result: string | null;
  pid: number | null;
  identity: string | null;
}
/**
 * Item 10: how this host runs local commands. `bwrap` (Linux) or `seatbelt` (macOS): under the OS
 * sandbox at `level` (full-access only by explicit operator setting). `none`: a host with no usable
 * sandbox, which refuses local commands unless the operator allowed them unsandboxed
 * (`allowUnsandboxed`); then it runs them and says so in every approval.
 */
export interface LocalSandbox {
  kind: SandboxKind;
  level: SandboxLevel;
  bwrap: Bwrap | null;
  seatbelt?: Seatbelt | null;
  /** The host config's `unsandboxed_commands: "allow"` (operator ruling 2026-10-30, option A). */
  allowUnsandboxed?: boolean;
  /** The host config's `command_network: "broker"`: a sandboxed command reaches the network only
   * through this stk local-commands socket (operator rulings 2026-10-30). */
  network?: { socket: string };
  /** Operator-allowed read-only paths outside the workspace (Phase 1, 2026-10-31). */
  readPaths?: string[];
}
/** The proxy a broker-network command uses: only the relay on loopback, nothing direct. */
function proxyEnv(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };
}
export class LocalCoding {
  private jobs = new Map<string, { stop: () => void; done: Promise<void> }>();
  /** Background tasks this controller owns; they belong to the session, not to a turn. */
  private live = new Map<string, BackgroundTask>();
  /** Output of recently ended tasks, so the model can read why one stopped. */
  private kept = new Map<string, { output: string; bytes: number; truncated: boolean }>();
  /** Background commands are for a person's own desk session only (Phase 3c). */
  public interactive: (session: string) => boolean = () => false;
  private closed = false;
  private unregister: () => void;
  /** Desk-session approval rules (allow/ask/deny), set by the service; absent means every request asks. */
  public rules?: ApprovalRules;
  constructor(
    readonly store: Store,
    readonly managed: ManagedWork,
    readonly active: (s: string, e: number, a: string) => void,
    readonly tools: ToolIdentity = serviceToolIdentity(),
    /** Chosen by the service from the host and the operator's setting. */
    public sandbox: LocalSandbox = { kind: 'none', level: 'full-access', bwrap: null },
  ) {
    this.unregister = managed.registerMcpController('local-coding-v1', {
      owns: (op) => !!store.db.prepare('SELECT 1 FROM local_calls WHERE operation_id=?').get(op.id),
      assert: (op) => this.guard(this.byOperation(op)),
      assertSettled: (op) => {
        const c = this.byOperation(op);
        if (c.pid && processIdentity(c.pid) === c.identity)
          throw new ServiceError('local_busy', 'Recorded command process is still present');
        if (this.jobs.has(c.id))
          throw new ServiceError('local_busy', 'Command resources are still active');
      },
    });
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS local_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,call_id TEXT NOT NULL,command TEXT NOT NULL,state TEXT NOT NULL,pid INTEGER,identity TEXT,exit_code INTEGER,started_at TEXT NOT NULL,ended_at TEXT)',
    );
    // A background task never outlives its controller: kill what a restart left and say so.
    for (const raw of store.db.prepare("SELECT * FROM local_tasks WHERE state='running'").all()) {
      const t = raw as unknown as TaskRow;
      if (t.pid && t.identity && processIdentity(t.pid) === t.identity)
        try {
          process.kill(-t.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      this.endTask(t, 'lost', null);
    }
    // A lost controller must never retry a possibly executed edit or command.
    for (const raw of store.db.prepare("SELECT * FROM local_calls WHERE state='running'").all()) {
      const c = raw as unknown as LocalCall;
      if (c.pid && c.identity && processIdentity(c.pid) === c.identity) {
        try {
          process.kill(-c.pid, 'SIGKILL');
        } catch {
          /* outcome remains uncertain */
        }
      }
      const pgid = c.result ? Number(JSON.parse(c.result).tool_pgid) : NaN;
      if (Number.isSafeInteger(pgid)) killToolGroup(this.tools, pgid);
      store.transaction(() => {
        this.change(c, 'outcome_unknown', {
          error:
            'Controller restarted during execution. Inspect the recorded intent and workspace; this operation will not replay.',
        });
        managed.workspaceUnknownInTransaction(c.operation_id);
      });
    }
  }
  get(id: string): LocalCall {
    const row = this.store.db.prepare('SELECT * FROM local_calls WHERE id=?').get(id);
    if (!row) throw new ServiceError('not_found', 'Local operation not found', 404);
    return row as unknown as LocalCall;
  }
  view(id: string) {
    const c = this.get(id),
      operation = this.managed.operation(c.operation_id),
      approval = this.managed.forOperation(c.operation_id);
    return {
      call: { id: c.id, state: c.state, operation_id: c.operation_id },
      operation,
      approval,
      result: c.result ? JSON.parse(c.result) : null,
    };
  }
  private byOperation(op: Operation): LocalCall {
    const row = this.store.db.prepare('SELECT id FROM local_calls WHERE operation_id=?').get(op.id);
    if (!row) throw new ServiceError('local_scope', 'Local operation has no owner');
    const c = this.get(String(row.id));
    if (op.target_version !== digest({ root: c.root, args: JSON.parse(c.args) }))
      throw new ServiceError('local_scope', 'Local review binding changed');
    return c;
  }
  private guard(c: LocalCall): void {
    this.store.execution.assert(c.session_id);
    if (this.store.hasUnknown(c.session_id))
      throw new ServiceError('operation_blocked', 'Unresolved effects block local permissions');
    assertUndoSettled(this.store, c.root);
    assertPermissionBinding(this.store, c.session_id, c.operation_id, c.root);
    if (this.closed || !this.store.localCoding(c.session_id))
      throw new ServiceError('local_denied', 'Local coding is not admitted');
    this.active(c.session_id, c.epoch, c.attempt_id);
    this.store.taskGrantCheck?.(c.session_id);
    if (this.store.session(c.session_id).cwd !== c.root || realpathSync(c.root) !== c.root)
      throw new ServiceError('workspace_changed', 'Workspace root changed');
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM local_calls c JOIN operations o ON o.id=c.operation_id WHERE c.root=? AND c.id!=? AND (c.state='running' OR (c.state='outcome_unknown' AND o.state='outcome_unknown'))",
        )
        .get(c.root, c.id)
    )
      throw new ServiceError(
        'local_busy',
        'Another operation or uncertain outcome owns this workspace',
      );
  }
  prepare(
    session: string,
    epoch: number,
    attempt: string,
    toolCall: string,
    input: Record<string, unknown>,
  ) {
    const prior = this.store.db
      .prepare(
        'SELECT id,input_digest FROM local_calls WHERE session_id=? AND epoch=? AND tool_call=?',
      )
      .get(session, epoch, toolCall);
    if (prior) {
      if (prior.input_digest !== digest(input))
        throw new ServiceError('request_conflict', 'Tool call already binds different arguments');
      return this.view(String(prior.id));
    }
    const root = this.store.session(session).cwd;
    const c: LocalCall = {
      id: randomUUID(),
      session_id: session,
      epoch,
      attempt_id: attempt,
      tool_call: toolCall,
      input_digest: digest(input),
      root,
      args: '',
      operation_id: '',
      state: 'prepared',
      result: null,
      pid: null,
      identity: null,
    };
    this.guard(c);
    const kind = string(input.action, 'action');
    let args:
      | { action: 'edit'; edits: LocalEdit[] }
      | {
          action: 'command';
          command: string;
          timeout_ms: number;
          background?: true;
          sandbox: { kind: string; level: string; bwrap: string | null; network?: 'broker' };
        };
    if (kind === 'edit') args = { action: 'edit', edits: prepareLocalEdits(root, input.edits) };
    else if (kind === 'command') {
      const timeout = input.timeout_ms ?? 30000;
      if (!Number.isInteger(timeout) || Number(timeout) < 100 || Number(timeout) > 120000)
        throw new ServiceError('invalid_field', 'Command timeout must be 100–120000 ms');
      const background = input.background === true;
      if (input.background !== undefined && typeof input.background !== 'boolean')
        throw new ServiceError('invalid_field', 'background must be true or false');
      if (background) this.assertBackground(session);
      const sb = this.sandboxFor(session);
      if (sb.kind === 'bwrap' && sb.level !== 'full-access' && !sb.bwrap)
        throw new ServiceError(
          'sandbox_unavailable',
          'This host has no usable bubblewrap, so it cannot run a sandboxed command; an operator can choose full access explicitly',
        );
      if (sb.kind === 'none' && sb.level !== 'full-access' && !sb.allowUnsandboxed)
        throw new ServiceError('sandbox_unavailable', UNSANDBOXED_REFUSAL);
      args = {
        action: 'command',
        command: string(input.command, 'command', 8192),
        timeout_ms: background ? BACKGROUND_LIFETIME : Number(timeout),
        ...(background ? { background: true as const } : {}),
        // Bound into the approval and the operation digest: the sandbox is part of what is approved.
        sandbox: {
          kind: sb.kind,
          level: sb.level,
          bwrap: sb.bwrap?.version ?? null,
          ...(this.brokerNetwork(sb) ? { network: 'broker' as const } : {}),
        },
      };
    } else throw new ServiceError('invalid_field', 'Choose edit or command');
    c.args = JSON.stringify(args);
    // Operator ruling 2026-10-31: full access asks only for commands this check calls dangerous.
    const danger: DangerVerdict =
      args.action === 'command'
        ? classifyCommand(args.command, {
            root,
            home: homedir(),
            tmp: [...new Set(['/tmp', '/private/tmp', tmpdir(), realpathSync(tmpdir())])],
          })
        : { dangerous: false };
    this.store.transaction(() => {
      const reviewed =
        args.action === 'edit'
          ? reviewLocalEdits(args.edits)
          : `Runs as ${this.tools.mode === 'tools-user' ? `tools user ${this.tools.user} (uid ${this.tools.uid})` : 'your local user'}, ${this.sandboxText(this.bound(args))}\nDirectory: ${root}${args.background ? `\nRuns in the background until stopped (at most ${BACKGROUND_LIFETIME / 3600000} h); the last ${TASK_TAIL / 1024} KiB of output is kept` : `\nTimeout: ${args.timeout_ms} ms`}\n${danger.dangerous ? `Dangerous (${danger.category}): ${danger.reason}\n` : ''}Command:\n${args.command}`;
      const permission = this.managed.prepareWorkspaceInTransaction(
        session,
        epoch,
        attempt,
        toolCall,
        `Local ${kind}: ${root}`,
        reviewed,
        digest({ root, args }),
      );
      c.operation_id = permission.operation.id;
      this.store.db
        .prepare(
          'INSERT INTO local_calls(id,session_id,attempt_id,epoch,tool_call,input_digest,root,args,operation_id,state) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          c.id,
          session,
          attempt,
          epoch,
          toolCall,
          c.input_digest,
          root,
          c.args,
          c.operation_id,
          c.state,
        );
      this.store.event(session, 'local.prepared', {
        call_id: c.id,
        attempt_id: attempt,
        action: kind,
      });
    });
    const policy = permissionPolicy(this.store, session);
    // Desk-session rules: a matching deny refuses, a matching allow approves and is recorded with the
    // rule that decided it; anything else falls through to the scoped-edit policy and then asks.
    if (this.rules && policy.mode !== 'inspect' && this.rules.applies(session)) {
      const request: RuleRequest =
        args.action === 'command'
          ? { tool: 'command', argv: commandArgv(args.command) }
          : { tool: 'edit', paths: args.edits.map((e) => e.path) };
      // A repo's allow rules cannot approve a dangerous command: only the person's own rules can.
      const usable = (all: ReturnType<ApprovalRules['list']>) =>
        danger.dangerous ? all.filter((r) => !(r.source === 'repo' && r.effect === 'allow')) : all;
      const decided = evaluateRules(usable(this.rules.list(session)), request);
      const approval = this.managed.forOperation(c.operation_id);
      const rule = decided.rule && {
        id: decided.rule.id,
        source: decided.rule.source,
        effect: decided.rule.effect,
        tool: decided.rule.tool,
        ...(decided.rule.command ? { command: decided.rule.command } : {}),
        ...(decided.rule.paths ? { paths: decided.rule.paths } : {}),
      };
      if (decided.effect === 'deny' && rule) {
        this.managed.decide(
          approval.id,
          'rule-deny:' + c.id,
          approval.revision,
          approval.operation_digest,
          'deny',
        );
        this.store.transaction(() =>
          this.store.event(session, 'permission.rule-denied', {
            rule,
            call_id: c.id,
            operation_id: c.operation_id,
          }),
        );
      } else if (decided.effect === 'allow' && rule) {
        const rules = this.rules;
        this.managed.decide(
          approval.id,
          'rule:' + c.id,
          approval.revision,
          approval.operation_digest,
          'approve',
          {
            receipt: {
              policy_digest: permissionDigest(policy),
              policy_revision: policy.revision,
              rule,
              root,
              call_id: c.id,
            },
            decidedBy: 'rule:' + rule.source,
            authorize: () => {
              this.guard(c);
              const again = evaluateRules(usable(rules.list(session)), request);
              if (again.effect !== 'allow' || again.rule?.id !== rule.id)
                throw new ServiceError('permission_changed', 'Approval rules changed');
            },
          },
        );
      }
    }
    // The session's mode approves by itself only what it covers (Phase 2b): scoped or ordinary
    // project edits, and, in auto, commands that stay inside the OS sandbox. Re-checked at decision.
    const covered = (p: typeof policy) =>
      args.action === 'edit'
        ? autoApprovesEdits(
            p,
            args.edits.map((e) => e.path),
          )
        : autoApprovesCommands(p, this.sandboxed(this.bound(args)), danger.dangerous);
    if (this.managed.forOperation(c.operation_id).state === 'pending' && covered(policy)) {
      const approval = this.managed.forOperation(c.operation_id);
      this.managed.decide(
        approval.id,
        'scoped:' + c.id,
        approval.revision,
        approval.operation_digest,
        'approve',
        {
          receipt: {
            policy_digest: permissionDigest(policy),
            policy_revision: policy.revision,
            root,
            call_id: c.id,
          },
          authorize: () => {
            this.guard(c);
            const fresh = permissionPolicy(this.store, session);
            if (permissionDigest(fresh) !== permissionDigest(policy) || !covered(fresh))
              throw new ServiceError('permission_changed', 'Scoped edit policy changed');
            if (args.action === 'edit') verifyLocalEdits(root, args.edits);
          },
        },
      );
      // YOLO approves everything; each approval is recorded with what full access would have asked.
      if (policy.access === 'yolo')
        this.store.transaction(() =>
          this.store.event(session, 'permission.yolo-approved', {
            call_id: c.id,
            operation_id: c.operation_id,
            action: args.action,
            ...(args.action === 'command' ? { command: args.command } : {}),
            ...(danger.dangerous
              ? { would_have_asked: { category: danger.category, reason: danger.reason } }
              : {}),
          }),
        );
    }
    return this.view(c.id);
  }
  private change(c: LocalCall, state: string, result: unknown): void {
    this.store.db
      .prepare('UPDATE local_calls SET state=?,result=? WHERE id=?')
      .run(state, JSON.stringify(result), c.id);
    this.store.event(c.session_id, 'local.' + state, {
      call_id: c.id,
      attempt_id: c.attempt_id,
      result,
    });
  }
  run(id: string) {
    const c = this.get(id);
    if (c.state !== 'prepared') return this.view(id);
    this.guard(c);
    const approval = this.managed.forOperation(c.operation_id);
    if (
      approval.state !== 'pending' &&
      !(approval.state === 'decided' && approval.decision === 'approve')
    ) {
      this.store.transaction(() =>
        this.change(c, 'denied', { error: 'Operation was denied or its approval expired' }),
      );
      return this.view(id);
    }
    const args = object(JSON.parse(c.args));
    this.store.transaction(() => {
      if (!this.managed.takePermissionInTransaction(c.operation_id)) return;
      this.change(c, 'running', { applied: [] });
    });
    if (this.get(id).state !== 'running') return this.view(id);
    if (args.action === 'edit') {
      const applied: string[] = [];
      let entered = false;
      try {
        verifyLocalEdits(c.root, args.edits as LocalEdit[]);
        entered = true;
        const progress = (path: string) => {
          applied.push(path);
          this.store.transaction(() => this.change(c, 'running', { applied }));
        };
        if (this.tools.mode === 'tools-user')
          applyEditsAsTools(this.tools, c.root, args.edits as LocalEdit[], progress);
        else applyLocalEdits(c.root, args.edits as LocalEdit[], progress);
        verifyLocalEdits(
          c.root,
          (args.edits as LocalEdit[]).map((edit) => ({ ...edit, before: edit.after })),
        );
        this.store.transaction(() => {
          const result = { applied, verified: true, tool_uid: this.tools.uid };
          this.change(c, 'succeeded', result);
          this.managed.workspaceResultInTransaction(c.operation_id, result);
        });
      } catch (error) {
        this.store.transaction(() => {
          this.change(c, entered ? 'outcome_unknown' : 'failed', {
            applied,
            error:
              error instanceof ServiceError
                ? error.message
                : 'File apply failed; inspect recorded edits',
          });
          if (entered) this.managed.workspaceUnknownInTransaction(c.operation_id);
          else this.managed.workspaceDefiniteFailureInTransaction(c.operation_id);
        });
      }
    } else if (args.background === true) this.background(c, String(args.command), this.bound(args));
    else this.command(c, String(args.command), Number(args.timeout_ms), this.bound(args));
    return this.view(id);
  }
  /** The sandbox for a new command in this session: the host's, or full access if the person chose
   * it for this session (Phase 2b). Bound into the command's approval and digest. */
  private sandboxFor(session: string): LocalSandbox {
    return permissionPolicy(this.store, session).access
      ? { ...this.sandbox, level: 'full-access' }
      : this.sandbox;
  }
  /** The sandbox a prepared command was approved under. */
  private bound(args: { sandbox?: { level?: string } }): LocalSandbox {
    return args.sandbox?.level === 'full-access'
      ? { ...this.sandbox, level: 'full-access' }
      : this.sandbox;
  }
  private sandboxed(sb: LocalSandbox): boolean {
    return sb.kind !== 'none' && sb.level !== 'full-access';
  }
  /** Where this session's next command runs, in a word or two for the status and side panels. */
  commandSandbox(session: string): string {
    const access = permissionPolicy(this.store, session).access;
    if (access) return access === 'yolo' ? 'YOLO' : 'full access';
    if (this.sandbox.level === 'full-access') return 'no sandbox';
    if (this.sandbox.kind === 'none')
      return this.sandbox.allowUnsandboxed ? 'no sandbox' : 'refused';
    return this.sandbox.kind === 'seatbelt' ? 'Seatbelt' : 'bubblewrap';
  }
  private sandboxText(sb: LocalSandbox = this.sandbox): string {
    const { kind, level } = sb;
    if (level === 'full-access')
      return 'unsandboxed: the operator chose full access. May access files and network beyond this workspace.';
    if (kind === 'none')
      return 'unsandboxed: this host has no usable command sandbox, so the command may access files and network beyond this workspace.';
    const name = kind === 'seatbelt' ? 'Seatbelt' : 'bubblewrap';
    const net = this.brokerNetwork(sb)
      ? 'network: through the broker allowlist (hosts set by the stk policy), nothing direct.'
      : 'has no network.';
    const reads = this.sandbox.readPaths?.length
      ? ` It can also read ${this.sandbox.readPaths.length} operator-allowed path${this.sandbox.readPaths.length === 1 ? '' : 's'} outside the workspace.`
      : '';
    return level === 'read-only'
      ? `in a ${name} sandbox (read-only): it can read this workspace but write nothing, and ${net}${reads}`
      : `in a ${name} sandbox (workspace-write): it can write only inside this workspace, and ${net}${reads}`;
  }
  /** Broker network applies only to a sandboxed command: unsandboxed ones are not confined anyway. */
  private brokerNetwork(sb: LocalSandbox = this.sandbox): { socket: string } | null {
    return sb.network && this.sandboxed(sb) ? sb.network : null;
  }
  /** The process a command runs as. Under the tools user, the host-side shell reports its own
   * process group (the one a stop kills) before exec-ing bubblewrap, whose PID namespace would
   * otherwise report a number that means nothing on the host. */
  private commandArgv(
    root: string,
    script: string,
    tmp?: string,
    relay?: BrokerRelay | null,
    sb: LocalSandbox = this.sandbox,
  ): string[] {
    const sandboxed = this.sandboxed(sb);
    const inner = (s: string) =>
      !sandboxed
        ? ['/bin/sh', '-c', s]
        : sb.kind === 'seatbelt'
          ? seatbeltArgv(sb.level, root, tmp ?? '', ['/bin/sh', '-c', s], sb.seatbelt ?? null, {
              network: false,
              ...(relay?.port ? { brokerPort: relay.port } : {}),
              readPaths: sb.readPaths ?? [],
            })
          : sandboxArgv(sb.level, root, ['/bin/sh', '-c', s], sb.bwrap, {
              network: false,
              ...(relay?.dir ? { broker: { dir: relay.dir, node: process.execPath } } : {}),
              readPaths: sb.readPaths ?? [],
            });
    if (this.tools.mode !== 'tools-user') return inner(script);
    const marker = 'umask 0002\nprintf \'salaam-tool-pgid:%s\\n\' "$$"\n';
    return sandboxed
      ? toolArgv(this.tools, [
          '/usr/bin/setsid',
          '-w',
          '/bin/sh',
          '-c',
          marker + 'exec "$@"',
          'sh',
          ...inner(script),
        ])
      : toolArgv(this.tools, ['/usr/bin/setsid', '-w', '/bin/sh', '-c', marker + script]);
  }
  private command(c: LocalCall, command: string, timeout: number, sb: LocalSandbox): void {
    const broker = this.brokerNetwork(sb);
    // The relay is Salaam's, outside the sandbox: it forwards to stk and counts what was reached.
    const relayStarting = broker
      ? BrokerRelay.start(broker.socket, sb.kind === 'seatbelt' ? 'tcp' : 'unix')
      : Promise.resolve(null);
    // A stop that arrives while the relay starts still cancels the command once it is spawned.
    let early = false;
    let stop = () => {
      early = true;
    };
    // Seatbelt has no tmpfs: each command gets its own private tmp, removed when it ends.
    const tmp =
      sb.kind === 'seatbelt' && sb.level !== 'full-access'
        ? realpathSync(mkdtempSync(join(tmpdir(), 'salaam-cmd-')))
        : undefined;
    const set = (s: () => void) => {
      stop = s;
      if (early) s();
    };
    const done = relayStarting.then(
      (relay) => this.runCommand(c, command, timeout, tmp, relay, set, false, sb),
      () => this.runCommand(c, command, timeout, tmp, null, set, !!broker, sb),
    );
    this.jobs.set(c.id, { stop: () => stop(), done });
    if (tmp) void done.finally(() => rmSync(tmp, { recursive: true, force: true }));
  }
  private runCommand(
    c: LocalCall,
    command: string,
    timeout: number,
    tmp: string | undefined,
    relay: BrokerRelay | null,
    setStop: (stop: () => void) => void,
    relayFailed = false,
    sb: LocalSandbox = this.sandbox,
  ): Promise<void> {
    let stop = () => {};
    return new Promise<void>((resolve) => {
      let output = '',
        bytes = 0,
        reason: string | null = null,
        finished = false;
      // Deliberately do not inherit the daemon's provider credentials or service tokens.
      // Hold the shell before any user instruction until its identity is durably owned.
      const tools = this.tools.mode === 'tools-user';
      const script = 'IFS= read -r salaam_start_gate || exit 125\nexec 0</dev/null\n' + command;
      // As the tools user, setsid makes the shell its own group leader so it can be killed by group.
      const argv = this.commandArgv(c.root, script, tmp, relay, sb);
      let toolGroup: number | null = null,
        marker = tools ? '' : null,
        spawned = false;
      // Release the gate only once the process is owned and, as the tools user, its group is
      // known: otherwise a kill before the marker could miss a command already running.
      const release = () => {
        if (spawned && (!tools || toolGroup) && !reason && !finished) child.stdin.end('start\n');
      };
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: c.root,
        detached: true,
        env: {
          PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: process.env.HOME ?? c.root,
          LANG: 'en_US.UTF-8',
          TMPDIR: '/tmp',
          ...(relay ? proxyEnv(relay.port ?? COMMAND_NETWORK_PORT) : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let reap: NodeJS.Timeout | undefined;
      const kill = () => {
        if (toolGroup) killToolGroup(this.tools, toolGroup);
        if (tools) child.stdin.destroy();
        if (child.pid)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* close event or recovery retains uncertainty */
          }
        if (!finished && !reap)
          reap = setTimeout(() => {
            if (toolGroup) killToolGroup(this.tools, toolGroup);
            // A busy event loop runs timers before pending I/O: let an already delivered close
            // settle the outcome before declaring it unknown.
            setImmediate(() => {
              if (finished) return;
              reason = 'outcome_unknown';
              child.stdout.destroy();
              child.stderr.destroy();
              child.unref();
              finish(null);
            });
          }, 1500);
      };
      stop = () => {
        reason ??= 'cancelled';
        kill();
      };
      setStop(stop);
      const deadline = setTimeout(() => {
        reason = 'timed_out';
        kill();
      }, timeout);
      const guard = setInterval(() => {
        try {
          this.guard(c);
        } catch {
          stop();
        }
      }, 100);
      const collect = (chunk: Buffer) => {
        const left = Math.max(0, 65536 - bytes);
        bytes += chunk.length;
        output += chunk.subarray(0, left).toString('utf8');
        if (bytes > 65536) {
          reason = 'output_limited';
          kill();
        }
      };
      child.stdin.on('error', () => {
        reason ??= 'outcome_unknown';
        kill();
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (marker === null) return collect(chunk);
        marker += chunk.toString('latin1');
        const end = marker.indexOf('\n');
        if (end < 0) {
          if (marker.length > 64) {
            reason = 'outcome_unknown';
            kill();
          }
          return;
        }
        const found = /^salaam-tool-pgid:(\d+)$/.exec(marker.slice(0, end));
        const rest = Buffer.from(marker.slice(end + 1), 'latin1');
        marker = null;
        if (!found) {
          reason = 'outcome_unknown';
          kill();
          return;
        }
        toolGroup = Number(found[1]);
        try {
          this.store.transaction(() => this.change(c, 'running', { tool_pgid: toolGroup }));
        } catch {
          reason = 'outcome_unknown';
          kill();
        }
        if (rest.length) collect(rest);
        release();
      });
      child.stderr.on('data', collect);
      child.once('spawn', () => {
        try {
          const identity = processIdentity(child.pid!);
          if (!identity) throw Error('No process identity');
          this.store.transaction(() =>
            this.store.db
              .prepare('UPDATE local_calls SET pid=?,identity=? WHERE id=?')
              .run(child.pid!, identity, c.id),
          );
          try {
            this.guard(c);
          } catch {
            stop();
            return;
          }
          spawned = true;
          release();
        } catch {
          reason = 'outcome_unknown';
          kill();
        }
      });
      const finish = (code: number | null, error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        if (reap) clearTimeout(reap);
        clearInterval(guard);
        kill();
        this.jobs.delete(c.id);
        const state = reason ?? (error ? 'failed' : code === 0 ? 'succeeded' : 'failed');
        const network = relay
          ? relay.summary()
          : relayFailed
            ? { broker: 'unavailable' as const, connections: [] }
            : null;
        void relay?.close();
        // What the broker refused, in its own words, so the reason reaches the card.
        const refusals = (network?.connections ?? [])
          .filter((n) => n.refused && n.reason)
          .map((n) => `[network] refused ${n.target}: ${n.reason}`)
          .join('\n');
        const result = {
          exit_code: code,
          output: refusals
            ? output + (output.endsWith('\n') || !output ? '' : '\n') + refusals + '\n'
            : output,
          state,
          error: error ? 'Command could not start' : null,
          isolation:
            (tools ? 'tools-user-' : 'local-user-') +
            (this.sandboxed(sb) ? sb.kind + '-' + sb.level : 'no-os-sandbox'),
          sandbox: this.sandboxed(sb) ? sb.kind : 'none',
          tool_uid: this.tools.uid,
          ...(network ? { network } : {}),
        };
        this.store.transaction(() => {
          this.change(c, state, result);
          if (state === 'outcome_unknown')
            this.managed.workspaceUnknownInTransaction(c.operation_id);
          else
            this.managed.localExecutionResultInTransaction(
              c.operation_id,
              state === 'succeeded',
              result,
            );
        });
        resolve();
      };
      child.once('error', (e) => finish(null, e));
      child.once('close', (code) => finish(code));
    });
  }
  private assertBackground(session: string): void {
    if (!this.interactive(session))
      throw new ServiceError(
        'background_denied',
        'Background commands are only for an interactive local coding session',
      );
    if (this.tools.mode === 'tools-user')
      throw new ServiceError(
        'background_denied',
        'Background commands do not yet run as a separate tools user',
      );
    if ([...this.live.values()].filter((t) => t.session === session).length >= TASK_LIMIT)
      throw new ServiceError(
        'background_limit',
        `A session runs at most ${TASK_LIMIT} background commands; stop one first`,
      );
  }
  /** Launch an approved background command. Its operation settles once the process is owned;
   * the process then lives as a session task until it exits, is stopped, or the session ends. */
  private background(c: LocalCall, command: string, sb: LocalSandbox): void {
    const settle = (ok: boolean, result: Record<string, unknown>) =>
      this.store.transaction(() => {
        this.change(c, ok ? 'succeeded' : 'failed', result);
        this.managed.localExecutionResultInTransaction(c.operation_id, ok, result);
      });
    try {
      this.assertBackground(c.session_id);
    } catch (error) {
      settle(false, { error: (error as Error).message, background: true });
      return;
    }
    const id = 'task_' + randomUUID().slice(0, 8);
    const tmp =
      sb.kind === 'seatbelt' && sb.level !== 'full-access'
        ? realpathSync(mkdtempSync(join(tmpdir(), 'salaam-cmd-')))
        : undefined;
    // Network for a long-lived task needs a relay that lives as long; keep it simple and honest.
    const script = 'IFS= read -r salaam_start_gate || exit 125\nexec 0</dev/null\n' + command;
    const argv = this.commandArgv(c.root, script, tmp, null, sb);
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: c.root,
      detached: true,
      env: {
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME ?? c.root,
        LANG: 'en_US.UTF-8',
        TMPDIR: '/tmp',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let tail = Buffer.alloc(0),
      bytes = 0,
      ended: TaskState | null = null,
      resolve = () => {};
    const done = new Promise<void>((r) => (resolve = r));
    const kill = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
    };
    const task: BackgroundTask = {
      id,
      session: c.session_id,
      done,
      output: () => ({ output: tail.toString('utf8'), bytes, truncated: bytes > tail.length }),
      stop: (why) => {
        ended ??= why;
        kill();
      },
    };
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TASK_TAIL) tail = tail.subarray(tail.length - TASK_TAIL);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    const lifetime = setTimeout(() => task.stop('timed_out'), BACKGROUND_LIFETIME);
    // The session, not the turn, owns the task: it ends when local coding or its root goes away.
    const watch = setInterval(() => {
      try {
        if (this.closed || !this.store.localCoding(c.session_id)) throw Error('closed');
        if (this.store.session(c.session_id).cwd !== c.root) throw Error('moved');
      } catch {
        task.stop('stopped');
      }
    }, 1000);
    const finish = (code: number | null) => {
      clearTimeout(lifetime);
      clearInterval(watch);
      kill();
      this.live.delete(id);
      this.kept.set(id, task.output());
      if (this.kept.size > 32) this.kept.delete(this.kept.keys().next().value!);
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      const row = this.store.db.prepare('SELECT * FROM local_tasks WHERE id=?').get(id) as
        TaskRow | undefined;
      if (row) this.endTask(row, ended ?? 'exited', code);
      else settle(false, { error: 'Command could not start', background: true });
      resolve();
    };
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code));
    child.once('spawn', () => {
      try {
        const identity = processIdentity(child.pid!);
        if (!identity) throw Error('No process identity');
        this.store.transaction(() =>
          this.store.db
            .prepare(
              "INSERT INTO local_tasks(id,session_id,call_id,command,state,pid,identity,started_at) VALUES (?,?,?,?,'running',?,?,?)",
            )
            .run(id, c.session_id, c.id, command, child.pid!, identity, new Date().toISOString()),
        );
        this.live.set(id, task);
        settle(true, {
          background: true,
          task_id: id,
          state: 'running',
          isolation:
            'local-user-' + (this.sandboxed(sb) ? sb.kind + '-' + sb.level : 'no-os-sandbox'),
          sandbox: this.sandboxed(sb) ? sb.kind : 'none',
          note: 'Read its output with salaam_tasks; it keeps running after this turn.',
        });
        child.stdin.end('start\n');
      } catch {
        ended = 'lost';
        kill();
      }
    });
  }
  private endTask(t: TaskRow, state: TaskState, code: number | null): void {
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE local_tasks SET state=?,exit_code=?,ended_at=? WHERE id=? AND state='running'",
        )
        .run(state, code, new Date().toISOString(), t.id);
      this.store.event(t.session_id, 'local.task_finished', {
        task_id: t.id,
        command: t.command.slice(0, 200),
        state,
        exit_code: code,
      });
    });
  }
  /** The session's background tasks, newest first. */
  tasks(session: string) {
    return (
      this.store.db
        .prepare(
          'SELECT * FROM local_tasks WHERE session_id=? ORDER BY started_at DESC, rowid DESC',
        )
        .all(session) as unknown as TaskRow[]
    ).map((t) => ({
      id: t.id,
      command: t.command,
      state: t.state,
      exit_code: t.exit_code,
      pid: t.pid,
      started_at: t.started_at,
      ended_at: t.ended_at,
      bytes: this.live.get(t.id)?.output().bytes ?? null,
    }));
  }
  private task(session: string, id: string): TaskRow {
    const row = this.store.db
      .prepare('SELECT * FROM local_tasks WHERE id=? AND session_id=?')
      .get(id, session) as TaskRow | undefined;
    if (!row) throw new ServiceError('not_found', 'No such background task in this session', 404);
    return row;
  }
  /** The kept tail of a task's output. Output of a task this controller no longer owns is gone. */
  taskOutput(session: string, id: string) {
    const row = this.task(session, id);
    const live = this.live.get(id);
    return {
      task: { id: row.id, state: row.state, exit_code: row.exit_code },
      ...(live?.output() ?? this.kept.get(id) ?? { output: '', bytes: 0, truncated: false }),
    };
  }
  stopTask(session: string, id: string) {
    this.task(session, id);
    this.live.get(id)?.stop('stopped');
    return { stopping: this.live.has(id) };
  }
  async close(): Promise<void> {
    this.closed = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.stop();
    const tasks = [...this.live.values()];
    for (const t of tasks) t.stop('stopped');
    await Promise.all([...jobs.map((j) => j.done), ...tasks.map((t) => t.done)]);
    this.unregister();
  }
}
