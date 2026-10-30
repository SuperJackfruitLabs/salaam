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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { ManagedWork } from './managed.js';
import { digest, object, string, ServiceError, type Operation } from './protocol.js';
import {
  prepareLocalEdits,
  verifyLocalEdits,
  applyLocalEdits,
  type LocalEdit,
} from './local-edits.js';
import {
  permissionPolicy,
  permissionDigest,
  matchesEditScope,
  assertPermissionBinding,
} from './autonomy.js';
import { assertUndoSettled } from './local-undo.js';
import { processIdentity } from './supervisor.js';
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
}
export class LocalCoding {
  private jobs = new Map<string, { stop: () => void; done: Promise<void> }>();
  private closed = false;
  private unregister: () => void;
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
          sandbox: { kind: string; level: string; bwrap: string | null };
        };
    if (kind === 'edit') args = { action: 'edit', edits: prepareLocalEdits(root, input.edits) };
    else if (kind === 'command') {
      const timeout = input.timeout_ms ?? 30000;
      if (!Number.isInteger(timeout) || Number(timeout) < 100 || Number(timeout) > 120000)
        throw new ServiceError('invalid_field', 'Command timeout must be 100–120000 ms');
      if (
        this.sandbox.kind === 'bwrap' &&
        this.sandbox.level !== 'full-access' &&
        !this.sandbox.bwrap
      )
        throw new ServiceError(
          'sandbox_unavailable',
          'This host has no usable bubblewrap, so it cannot run a sandboxed command; an operator can choose full access explicitly',
        );
      if (
        this.sandbox.kind === 'none' &&
        this.sandbox.level !== 'full-access' &&
        !this.sandbox.allowUnsandboxed
      )
        throw new ServiceError('sandbox_unavailable', UNSANDBOXED_REFUSAL);
      args = {
        action: 'command',
        command: string(input.command, 'command', 8192),
        timeout_ms: Number(timeout),
        // Bound into the approval and the operation digest: the sandbox is part of what is approved.
        sandbox: {
          kind: this.sandbox.kind,
          level: this.sandbox.level,
          bwrap: this.sandbox.bwrap?.version ?? null,
        },
      };
    } else throw new ServiceError('invalid_field', 'Choose edit or command');
    c.args = JSON.stringify(args);
    this.store.transaction(() => {
      const reviewed =
        args.action === 'edit'
          ? args.edits
              .map((e) => `--- ${e.path}\n${e.before ?? '(new file)'}\n+++ ${e.path}\n${e.after}`)
              .join('\n\n')
          : `Runs as ${this.tools.mode === 'tools-user' ? `tools user ${this.tools.user} (uid ${this.tools.uid})` : 'your local user'}, ${this.sandboxText()}\nDirectory: ${root}\nTimeout: ${args.timeout_ms} ms\nCommand:\n${args.command}`;
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
    if (
      args.action === 'edit' &&
      matchesEditScope(
        policy,
        args.edits.map((e) => e.path),
      )
    ) {
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
            if (
              permissionDigest(fresh) !== permissionDigest(policy) ||
              args.action !== 'edit' ||
              !matchesEditScope(
                fresh,
                args.edits.map((e) => e.path),
              )
            )
              throw new ServiceError('permission_changed', 'Scoped edit policy changed');
            verifyLocalEdits(root, args.edits);
          },
        },
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
    } else this.command(c, String(args.command), Number(args.timeout_ms));
    return this.view(id);
  }
  private sandboxText(): string {
    const { kind, level } = this.sandbox;
    if (level === 'full-access')
      return 'unsandboxed: the operator chose full access. May access files and network beyond this workspace.';
    if (kind === 'none')
      return 'unsandboxed: this host has no usable command sandbox, so the command may access files and network beyond this workspace.';
    const name = kind === 'seatbelt' ? 'Seatbelt' : 'bubblewrap';
    return level === 'read-only'
      ? `in a ${name} sandbox (read-only): it can read this workspace but write nothing, and has no network.`
      : `in a ${name} sandbox (workspace-write): it can write only inside this workspace and has no network.`;
  }
  /** The process a command runs as. Under the tools user, the host-side shell reports its own
   * process group (the one a stop kills) before exec-ing bubblewrap, whose PID namespace would
   * otherwise report a number that means nothing on the host. */
  private commandArgv(root: string, script: string, tmp?: string): string[] {
    const sandboxed = this.sandbox.kind !== 'none' && this.sandbox.level !== 'full-access';
    const inner = (s: string) =>
      !sandboxed
        ? ['/bin/sh', '-c', s]
        : this.sandbox.kind === 'seatbelt'
          ? seatbeltArgv(
              this.sandbox.level,
              root,
              tmp ?? '',
              ['/bin/sh', '-c', s],
              this.sandbox.seatbelt ?? null,
              { network: false },
            )
          : sandboxArgv(this.sandbox.level, root, ['/bin/sh', '-c', s], this.sandbox.bwrap, {
              network: false,
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
  private command(c: LocalCall, command: string, timeout: number): void {
    let stop = () => {};
    // Seatbelt has no tmpfs: each command gets its own private tmp, removed when it ends.
    const tmp =
      this.sandbox.kind === 'seatbelt' && this.sandbox.level !== 'full-access'
        ? realpathSync(mkdtempSync(join(tmpdir(), 'salaam-cmd-')))
        : undefined;
    const done = new Promise<void>((resolve) => {
      let output = '',
        bytes = 0,
        reason: string | null = null,
        finished = false;
      // Deliberately do not inherit the daemon's provider credentials or service tokens.
      // Hold the shell before any user instruction until its identity is durably owned.
      const tools = this.tools.mode === 'tools-user';
      const script = 'IFS= read -r salaam_start_gate || exit 125\nexec 0</dev/null\n' + command;
      // As the tools user, setsid makes the shell its own group leader so it can be killed by group.
      const argv = this.commandArgv(c.root, script, tmp);
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
        const result = {
          exit_code: code,
          output,
          state,
          error: error ? 'Command could not start' : null,
          isolation:
            (tools ? 'tools-user-' : 'local-user-') +
            (this.sandbox.kind !== 'none' && this.sandbox.level !== 'full-access'
              ? this.sandbox.kind + '-' + this.sandbox.level
              : 'no-os-sandbox'),
          sandbox:
            this.sandbox.kind !== 'none' && this.sandbox.level !== 'full-access'
              ? this.sandbox.kind
              : 'none',
          tool_uid: this.tools.uid,
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
    this.jobs.set(c.id, { stop: () => stop(), done });
    if (tmp) void done.finally(() => rmSync(tmp, { recursive: true, force: true }));
  }
  async close(): Promise<void> {
    this.closed = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.stop();
    await Promise.all(jobs.map((j) => j.done));
    this.unregister();
  }
}
