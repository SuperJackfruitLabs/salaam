import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
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
export class LocalCoding {
  private jobs = new Map<string, { stop: () => void; done: Promise<void> }>();
  private closed = false;
  private unregister: () => void;
  constructor(
    readonly store: Store,
    readonly managed: ManagedWork,
    readonly active: (s: string, e: number, a: string) => void,
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
      | { action: 'command'; command: string; timeout_ms: number };
    if (kind === 'edit') args = { action: 'edit', edits: prepareLocalEdits(root, input.edits) };
    else if (kind === 'command') {
      const timeout = input.timeout_ms ?? 30000;
      if (!Number.isInteger(timeout) || Number(timeout) < 100 || Number(timeout) > 120000)
        throw new ServiceError('invalid_field', 'Command timeout must be 100–120000 ms');
      args = {
        action: 'command',
        command: string(input.command, 'command', 8192),
        timeout_ms: Number(timeout),
      };
    } else throw new ServiceError('invalid_field', 'Choose edit or command');
    c.args = JSON.stringify(args);
    this.store.transaction(() => {
      const reviewed =
        args.action === 'edit'
          ? args.edits
              .map((e) => `--- ${e.path}\n${e.before ?? '(new file)'}\n+++ ${e.path}\n${e.after}`)
              .join('\n\n')
          : `Runs as your local user, outside an OS sandbox. May access files and network beyond this workspace.\nDirectory: ${root}\nTimeout: ${args.timeout_ms} ms\nCommand:\n${args.command}`;
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
        applyLocalEdits(c.root, args.edits as LocalEdit[], (path) => {
          applied.push(path);
          this.store.transaction(() => this.change(c, 'running', { applied }));
        });
        verifyLocalEdits(
          c.root,
          (args.edits as LocalEdit[]).map((edit) => ({ ...edit, before: edit.after })),
        );
        this.store.transaction(() => {
          const result = { applied, verified: true };
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
  private command(c: LocalCall, command: string, timeout: number): void {
    let stop = () => {};
    const done = new Promise<void>((resolve) => {
      let output = '',
        bytes = 0,
        reason: string | null = null,
        finished = false;
      // Deliberately do not inherit the daemon's provider credentials or service tokens.
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: c.root,
        detached: true,
        env: {
          PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: process.env.HOME ?? c.root,
          LANG: 'en_US.UTF-8',
          TMPDIR: '/tmp',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let reap: NodeJS.Timeout | undefined;
      const kill = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* close event or recovery retains uncertainty */
          }
        if (!finished && !reap)
          reap = setTimeout(() => {
            reason = 'outcome_unknown';
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            finish(null);
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
      child.stdout.on('data', collect);
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
          isolation: 'local-user-no-os-sandbox',
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
  }
  async close(): Promise<void> {
    this.closed = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.stop();
    await Promise.all(jobs.map((j) => j.done));
    this.unregister();
  }
}
