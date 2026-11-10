import { BrokerRelay } from './command-network.js';
import { UNSANDBOXED_REFUSAL } from './command-sandbox.js';
import { randomUUID } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { classifyCommand, type DangerVerdict } from './command-danger.js';
import { publishesToRemote } from './git-helpers.js';
import type { ClassifierReview } from './danger-classifier.js';
import type { Store } from '../store/index.js';
import type { ManagedWork } from '../execution/index.js';
import {
  boundShellCommand,
  digest,
  object,
  string,
  ServiceError,
  type Operation,
  processIdentity,
} from '../core/index.js';
import {
  prepareLocalEdits,
  verifyLocalEdits,
  applyLocalEdits,
  reviewLocalEdits,
  type LocalEdit,
} from './edits.js';
import { permissionPolicy, assertPermissionBinding } from './autonomy.js';
import type { ApprovalRules } from './approval-rules.js';
import { assertUndoSettled } from './undo.js';
import type { HookRun } from './hooks.js';
import {
  applyEditsAsTools,
  killToolGroup,
  serviceToolIdentity,
  type ToolIdentity,
} from './tool-identity.js';
import {
  brokerNetwork,
  commandArgv,
  commandSandboxLabel,
  isSandboxed,
  privateTmp,
  sandboxText,
  type LocalCall,
  type LocalSandbox,
} from './command-launch.js';
import { runCommand, type CommandHost } from './foreground-command.js';
import { BackgroundTasks } from './background-tasks.js';
import { commandArgs, commandReview, type LocalArgs } from './command-request.js';
import { decideByPolicy } from './local-approval.js';
import { spawnHook } from './hook-runner.js';
import { localDiff } from './diff.js';
import { readInSandbox } from './sandbox-read.js';

export type { LocalSandbox } from './command-launch.js';

/** Edits bigger than this are left out of what an editor is shown. */
const SHOWN_EDIT_LIMIT = 256 * 1024;

/** A desk session's local coding tools: edits and commands, each prepared, approved (by the
 * person, a rule or the session's mode), run once under the host sandbox and settled. Commands
 * launch through command-launch, run in foreground-command or background-tasks; approval rules
 * and modes decide in local-approval. */
export class LocalCoding {
  private jobs = new Map<string, { stop: () => void; done: Promise<void> }>();
  /** Background tasks this controller owns; they belong to the session, not to a turn. */
  private background: BackgroundTasks;
  /** Background commands are for a person's own desk session only (Phase 3c). */
  public interactive: (session: string) => boolean = () => false;
  private closed = false;
  private unregister: () => void;
  /** Desk-session approval rules (allow/ask/deny), set by the service; absent means every request asks. */
  public rules?: ApprovalRules;
  /** Operator ruling 2026-11-01 (option 1): one command may ask to run outside the OS sandbox.
   * Off where the host forbids full access, since it is full access for that one command. */
  public allowOutsideSandbox = true;
  /** The optional small-model command reviewer (Phase 4c); absent means the rules alone decide. */
  public classifier?: {
    review(session: string, command: string, cwd: string): Promise<ClassifierReview | null>;
  };
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
    this.background = new BackgroundTasks({
      store,
      managed,
      tools: () => this.tools,
      closed: () => this.closed,
      interactive: (session) => this.interactive(session),
      change: (c, state, result) => this.change(c, state, result),
      argv: (root, script, tmp, relay, sb, listen) =>
        this.commandArgv(root, script, tmp, relay, sb, listen),
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
  /** The exact edits an edit request carries, or none for a command; files over 256 KiB are left out. */
  edits(
    session: string,
    by: { operation: string } | { toolCall: string },
  ): { root: string; edits: LocalEdit[] } | null {
    const row = this.store.db
      .prepare(
        `SELECT root,args FROM local_calls WHERE session_id=? AND ${'operation' in by ? 'operation_id' : 'tool_call'}=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(session, 'operation' in by ? by.operation : by.toolCall) as
      { root: string; args: string } | undefined;
    if (!row) return null;
    const args = object(JSON.parse(row.args));
    if (args.action !== 'edit') return null;
    const small = (text: string | null) =>
      text === null || Buffer.byteLength(text) <= SHOWN_EDIT_LIMIT;
    return {
      root: row.root,
      edits: (args.edits as LocalEdit[]).filter((e) => small(e.before) && small(e.after)),
    };
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
  /** prepare, after the optional reviewer has looked at a command the session would run unasked. */
  async prepareReviewed(
    session: string,
    epoch: number,
    attempt: string,
    toolCall: string,
    input: Record<string, unknown>,
  ) {
    let review: ClassifierReview | null = null;
    if (this.classifier && input.action === 'command' && typeof input.command === 'string') {
      const p = permissionPolicy(this.store, session);
      // Only where the mode would run the command without asking; review mode asks anyway.
      if (p.access || p.mode === 'auto') {
        const root = this.store.session(session).cwd;
        if (!classifyCommand(input.command, this.dangerContext(root)).dangerous)
          review = await this.classifier.review(session, input.command, root);
      }
    }
    return this.prepare(session, epoch, attempt, toolCall, input, review);
  }
  private dangerContext(root: string) {
    return {
      root,
      home: homedir(),
      tmp: [...new Set(['/tmp', '/private/tmp', tmpdir(), realpathSync(tmpdir())])],
    };
  }
  /** Has this tool call already been prepared? */
  hasCall(session: string, epoch: number, toolCall: string): boolean {
    return !!this.store.db
      .prepare('SELECT 1 FROM local_calls WHERE session_id=? AND epoch=? AND tool_call=?')
      .get(session, epoch, toolCall);
  }
  /** A `!command` turn runs only what was typed, once (trial polish #12): enforced here, not by
   * the model following its instruction, so it holds in auto, full access and YOLO alike. */
  private assertShellBinding(session: string, attempt: string, input: Record<string, unknown>) {
    const row = this.store.db
      .prepare(
        'SELECT s.text FROM attempts a JOIN submissions s ON s.id=a.submission_id WHERE a.id=? AND a.session_id=?',
      )
      .get(attempt, session) as { text: string } | undefined;
    const bound = row ? boundShellCommand(row.text) : undefined;
    if (bound === undefined) return;
    if (input.action !== 'command' || input.command !== bound || input.background)
      throw new ServiceError(
        'shell_binding',
        `This turn runs only the command you typed: ${bound}. Run exactly that, unchanged.`,
      );
    const ran = this.store.db
      .prepare('SELECT 1 FROM local_calls WHERE session_id=? AND attempt_id=?')
      .get(session, attempt);
    if (ran)
      throw new ServiceError(
        'shell_binding',
        'This turn already ran the command you typed. Report its output; do not run anything else.',
      );
  }
  prepare(
    session: string,
    epoch: number,
    attempt: string,
    toolCall: string,
    input: Record<string, unknown>,
    review: ClassifierReview | null = null,
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
    this.assertShellBinding(session, attempt, input);
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
    let args: LocalArgs;
    if (kind === 'edit') args = { action: 'edit', edits: prepareLocalEdits(root, input.edits) };
    else if (kind === 'command')
      args = commandArgs(input, {
        assertBackground: () => this.background.assertAllowed(session),
        sandboxFor: () => this.sandboxFor(session),
        allowOutsideSandbox: this.allowOutsideSandbox,
        toolsUser: this.tools.mode === 'tools-user',
      });
    else throw new ServiceError('invalid_field', 'Choose edit or command');
    c.args = JSON.stringify(args);
    const { danger, escalated, publishes } = this.assess(args, root, review);
    this.persist(c, kind, args, danger, publishes, review, escalated);
    decideByPolicy(
      {
        store: this.store,
        managed: this.managed,
        rules: this.rules,
        guard: (call) => this.guard(call),
        sandboxedUnder: (command) => this.sandboxed(this.bound(command)),
      },
      session,
      c,
      root,
      args,
      danger,
      publishes,
      escalated,
    );
    return this.view(c.id);
  }
  /** How risky a request is: the rules' danger check, raised (never lowered) by the reviewer. */
  private assess(args: LocalArgs, root: string, review: ClassifierReview | null) {
    // Operator ruling 2026-10-31: full access asks only for commands this check calls dangerous.
    const rulesDanger: DangerVerdict =
      args.action === 'command'
        ? classifyCommand(args.command, this.dangerContext(root))
        : { dangerous: false };
    // Phase 4c: the reviewer can only add a reason to ask, never remove one.
    const escalated = !rulesDanger.dangerous && args.action === 'command' && !!review?.escalate;
    const danger: DangerVerdict =
      escalated && review
        ? {
            dangerous: true,
            category: 'classifier',
            reason: `${review.reason} (reviewed by ${review.model})`,
            segment: (args as { command: string }).command,
          }
        : rulesDanger;
    // Pushing and opening a pull request ask in every mode but YOLO (operator ruling 2026-10-31).
    const publishes = args.action === 'command' ? publishesToRemote(args.command) : null;
    return { danger, escalated, publishes };
  }
  /** Record the prepared call with its permission, and what the reviewer said. */
  private persist(
    c: LocalCall,
    kind: string,
    args: LocalArgs,
    danger: DangerVerdict,
    publishes: string | null,
    review: ClassifierReview | null,
    escalated: boolean,
  ): void {
    const { session_id: session, epoch, attempt_id: attempt, tool_call: toolCall, root } = c;
    this.store.transaction(() => {
      const reviewed =
        args.action === 'edit'
          ? reviewLocalEdits(args.edits)
          : commandReview(
              this.tools,
              this.sandboxText(this.bound(args), !!args.outside_sandbox),
              root,
              args,
              danger,
              publishes,
            );
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
    if (review)
      this.store.transaction(() =>
        this.store.event(session, 'permission.classifier', {
          call_id: c.id,
          operation_id: c.operation_id,
          model: review.model,
          verdict: review.verdict,
          escalated,
          ...(review.reason ? { reason: review.reason } : {}),
        }),
      );
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
    } else if (args.background === true)
      this.background.start(c, String(args.command), this.bound(args));
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
    return isSandboxed(sb);
  }
  /** Where this session's next command runs, in a word or two for the status and side panels. */
  commandSandbox(session: string): string {
    return commandSandboxLabel(this.sandbox, permissionPolicy(this.store, session).access);
  }
  private sandboxText(sb: LocalSandbox = this.sandbox, outside = false): string {
    return sandboxText(this.sandbox, sb, outside);
  }
  /** Run a hook (Phase 4b) as one of this session's sandboxed commands would run: the same sandbox
   * and level, no network, a minimal environment, `input` on stdin, bounded output and a timeout.
   * Never as the tools user, whose process accounting is for approved operations only. */
  runHook(session: string, command: string, input: string, timeoutMs: number): Promise<HookRun> {
    const refused = (why: string): Promise<HookRun> =>
      Promise.resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        refused: why,
      });
    if (this.tools.mode === 'tools-user')
      return refused('Hooks do not run when commands run as a separate tools user');
    const sb = this.sandboxFor(session);
    if (sb.kind === 'bwrap' && sb.level !== 'full-access' && !sb.bwrap)
      return refused('This host has no usable bubblewrap, so it cannot run a sandboxed hook');
    if (sb.kind === 'none' && sb.level !== 'full-access' && !sb.allowUnsandboxed)
      return refused(UNSANDBOXED_REFUSAL);
    const root = this.store.session(session).cwd;
    const tmp = privateTmp(sb, 'salaam-hook-');
    const argv = this.commandArgv(root, command, tmp, null, sb);
    return spawnHook(argv, root, input, timeoutMs, tmp);
  }
  /** The workspace diff for the diff view. When this host has a command sandbox, git runs inside
   * it, read-only, even for a session in full access: the repository's config may have been
   * written by a sandboxed command, and a content filter it names must run confined, not on the
   * host. Without one, commands were never confined and git runs on the host, hardened. */
  diff(session: string): Promise<string> {
    const root = this.store.session(session).cwd;
    const host = { ...this.sandbox, level: 'read-only' as const };
    return isSandboxed(host) && (host.bwrap || host.seatbelt)
      ? localDiff(root, (args) => readInSandbox(host, root, args))
      : localDiff(root);
  }
  /** The process a command runs as (see commandArgv). */
  private commandArgv(
    root: string,
    script: string,
    tmp?: string,
    relay?: BrokerRelay | null,
    sb: LocalSandbox = this.sandbox,
    listen = false,
  ): string[] {
    return commandArgv(this.tools, root, script, tmp, relay, sb, listen);
  }
  private command(c: LocalCall, command: string, timeout: number, sb: LocalSandbox): void {
    const broker = brokerNetwork(sb);
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
    const tmp = privateTmp(sb, 'salaam-cmd-');
    const set = (s: () => void) => {
      stop = s;
      if (early) s();
    };
    const done = relayStarting.then(
      (relay) => runCommand(this.commandHost(), c, command, timeout, tmp, relay, set, false, sb),
      () => runCommand(this.commandHost(), c, command, timeout, tmp, null, set, !!broker, sb),
    );
    this.jobs.set(c.id, { stop: () => stop(), done });
    if (tmp) void done.finally(() => rmSync(tmp, { recursive: true, force: true }));
  }
  /** What a foreground command needs from this controller. */
  private commandHost(): CommandHost {
    return {
      store: this.store,
      managed: this.managed,
      tools: this.tools,
      guard: (c) => this.guard(c),
      change: (c, state, result) => this.change(c, state, result),
      argv: (root, script, tmp, relay, sb, listen) =>
        this.commandArgv(root, script, tmp, relay, sb, listen),
      forget: (id) => this.jobs.delete(id),
    };
  }
  /** The session's background tasks, newest first. */
  tasks(session: string) {
    return this.background.list(session);
  }
  /** The kept tail of a task's output. Output of a task this controller no longer owns is gone. */
  taskOutput(session: string, id: string) {
    return this.background.output(session, id);
  }
  stopTask(session: string, id: string) {
    return this.background.stop(session, id);
  }
  async close(): Promise<void> {
    this.closed = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.stop();
    const tasks = this.background.stopAll();
    await Promise.all([...jobs.map((j) => j.done), ...tasks]);
    this.unregister();
  }
}
