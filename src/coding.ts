import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, ServiceError, string, integer } from './protocol.js';
import type { Store } from './store.js';
import type { Artifacts } from './artifacts.js';
import { Workspaces, readTree, filePath, type WorkspaceTree } from './workspaces.js';
import { COMMAND_LIMITS, type ExecutionBackend } from './coding-executor.js';

export interface CommandRun {
  id: string;
  session_id: string;
  workspace_id: string;
  attempt_id: string | null;
  step_key: string;
  input_digest: string;
  command: string;
  cwd: string;
  workspace_revision: number;
  workspace_digest: string;
  profile_digest: string;
  engine_id: string;
  snapshot_artifact: string;
  container_id: string | null;
  exec_id: string | null;
  state: string;
  resume_state: string | null;
  exit_code: number | null;
  output: string;
  result_artifact: string | null;
  error: string | null;
  created_at: number;
  deadline: number;
  cancelled: number;
}
export const commandTerminal = (state: string): boolean =>
  ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limited', 'interrupted'].includes(
    state,
  );
export class CodingWork {
  private jobs = new Map<string, Promise<void>>();
  private closing = false;
  constructor(
    readonly store: Store,
    readonly workspaces: Workspaces,
    readonly artifacts: Artifacts,
    readonly executor: ExecutionBackend | undefined,
    private readonly failed: (session: string, error: Error) => void,
  ) {}
  binding(
    session: string,
  ):
    | { workspace_id: string; files: true; commands: boolean; profile_digest: string | null }
    | undefined {
    const w = this.workspaces.find(session);
    if (!w || !this.workspaces.root) return;
    return {
      workspace_id: w.id,
      files: true,
      commands: !!this.executor,
      profile_digest: this.executor?.profileDigest ?? null,
    };
  }
  assertSafe(session: string): void {
    if (
      this.store.db
        .prepare("SELECT 1 FROM command_runs WHERE session_id=? AND state='outcome_unknown'")
        .get(session)
    )
      throw new ServiceError(
        'executor_unresolved',
        'Reconcile the uncertain executor before new grants',
      );
    const w = this.workspaces.find(session);
    if (w?.state === 'conflict')
      throw new ServiceError('workspace_conflict', 'Workspace requires reconciliation');
  }
  file(
    session: string,
    epoch: number,
    attempt: string,
    call: string,
    args: Record<string, unknown>,
  ): unknown {
    this.assertSafe(session);
    if (args.action === 'patch') return this.workspaces.patch(session, `${epoch}:${call}`, args);
    return this.store.request(`workspace:${session}:${epoch}`, call, args, () => {
      const result = this.workspaces.read(session, args);
      this.store.event(session, 'workspace.tool_completed', {
        attempt_id: attempt,
        tool_call_id: call,
        action: args.action,
        result_digest: digest(result),
      });
      return result;
    });
  }
  get(session: string, id: string): CommandRun {
    const row = this.store.db
      .prepare('SELECT * FROM command_runs WHERE id=? AND session_id=?')
      .get(id, session) as unknown as CommandRun | undefined;
    if (!row) throw new ServiceError('not_found', 'Command not found', 404);
    return row;
  }
  list(session: string, summary = false): CommandRun[] {
    return this.store.db
      .prepare(
        `SELECT ${summary ? "id,session_id,workspace_id,attempt_id,step_key,command,cwd,workspace_revision,workspace_digest,profile_digest,engine_id,container_id,exec_id,state,exit_code,error,created_at,deadline,cancelled,'' AS output" : '*'} FROM command_runs WHERE session_id=? ORDER BY created_at DESC LIMIT 100`,
      )
      .all(session) as unknown as CommandRun[];
  }
  start(
    session: string,
    attempt: string | null,
    args: Record<string, unknown>,
    authorize: () => void,
  ): CommandRun {
    const step = string(args.step_key, 'step_key', 128),
      command = string(args.command, 'command', 8192),
      cwd = args.cwd === undefined || args.cwd === '.' ? '.' : filePath(args.cwd);
    const revision = integer(args.expected_revision, 'expected_revision'),
      input = digest({ step, command, cwd, revision });
    const prior = this.store.db
      .prepare('SELECT id,input_digest FROM command_runs WHERE session_id=? AND step_key=?')
      .get(session, step);
    if (prior) {
      if (prior.input_digest !== input)
        throw new ServiceError(
          'command_conflict',
          'Command step already binds different arguments',
        );
      return this.get(session, String(prior.id));
    }
    authorize();
    this.assertSafe(session);
    if (!this.executor || this.closing)
      throw new ServiceError('coding_disabled', 'No proven command executor is configured');
    const active = this.store.db
      .prepare(
        "SELECT count(*) AS n FROM command_runs WHERE state NOT IN ('succeeded','failed','cancelled','timed_out','output_limited','interrupted')",
      )
      .get()!;
    if (Number(active.n) >= COMMAND_LIMITS.globalConcurrency)
      throw new ServiceError('command_limit', 'Global command concurrency limit reached');
    const w = this.workspaces.verify(session);
    if (w.revision !== revision)
      throw new ServiceError('workspace_changed', 'Workspace revision changed');
    const tree = readTree(w.root);
    if (digest(tree) !== w.digest)
      throw new ServiceError('workspace_changed', 'Workspace changed during command capture');
    if (cwd !== '.' && !Object.keys(tree).some((path) => path.startsWith(cwd + '/')))
      throw new ServiceError('not_found', 'Command directory not found', 404);
    const snapshot = this.artifacts.prepare(session, JSON.stringify(tree)),
      id = randomUUID(),
      created = Date.now();
    this.workspaces.lock(session, id);
    try {
      this.store.transaction(() => {
        authorize();
        this.workspaces.verify(session, id);
        this.store.taskCommandAdmission?.(session);
        snapshot.commit();
        this.store.db
          .prepare(
            `INSERT INTO command_runs(id,session_id,workspace_id,attempt_id,step_key,input_digest,command,cwd,workspace_revision,workspace_digest,profile_digest,engine_id,snapshot_artifact,state,created_at,deadline)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'accepted',?,?)`,
          )
          .run(
            id,
            session,
            w.id,
            attempt,
            step,
            input,
            command,
            cwd,
            revision,
            w.digest,
            this.executor!.profileDigest,
            this.executor!.engineId,
            snapshot.id,
            created,
            created +
              Math.min(
                COMMAND_LIMITS.runtimeMs,
                this.store.taskRemainingRuntime?.(session) ?? COMMAND_LIMITS.runtimeMs,
              ),
          );
        this.store.event(session, 'command.accepted', {
          run_id: id,
          attempt_id: attempt,
          step_key: step,
          command,
          cwd,
          workspace_id: w.id,
          workspace_revision: revision,
          workspace_digest: w.digest,
          profile_digest: this.executor!.profileDigest,
        });
      });
    } catch (error) {
      this.workspaces.unlock(session, id);
      this.store.taskBudgetDenied?.(session, error);
      throw error;
    }
    this.follow(id, session);
    return this.get(session, id);
  }
  private transition(run: CommandRun, state: string, extra: Partial<CommandRun> = {}): void {
    this.store.transaction(() => {
      const keys = Object.keys(extra);
      this.store.db
        .prepare(
          `UPDATE command_runs SET state=?${keys.map((key) => `,${key}=?`).join('')} WHERE id=?`,
        )
        .run(state, ...Object.values(extra), run.id);
      this.store.event(run.session_id, 'command.' + state, {
        run_id: run.id,
        exit_code: extra.exit_code ?? run.exit_code,
        error: extra.error ?? null,
      });
    });
  }
  private source(run: CommandRun): string {
    return join(this.workspaces.root!, '.commands', run.id);
  }
  private materialize(run: CommandRun): void {
    const tree = JSON.parse(this.artifacts.read(run.snapshot_artifact)) as WorkspaceTree,
      root = this.source(run);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755);
    for (const [path, file] of Object.entries(tree)) {
      filePath(path);
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true, mode: 0o755 });
      const fd = openSync(full, 'wx', 0o444);
      try {
        writeFileSync(fd, Buffer.from(file.content, 'base64'));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(full, file.executable ? 0o555 : 0o444);
    }
  }
  private follow(id: string, session: string): void {
    if (this.jobs.has(id) || this.closing || commandTerminal(this.get(session, id).state)) return;
    const task = this.monitor(id, session)
      .catch((error) => {
        try {
          const run = this.get(session, id);
          this.transition(run, 'outcome_unknown', {
            resume_state: run.resume_state ?? run.state,
            error: 'Executor or persistence control failed',
          });
        } catch {}
        this.failed(session, error as Error);
      })
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, task);
  }
  private async monitor(id: string, session: string): Promise<void> {
    const backend = this.executor!;
    let run = this.get(session, id);
    if (run.profile_digest !== backend.profileDigest || run.engine_id !== backend.engineId)
      throw new Error('Executor identity changed');
    if (run.state === 'accepted') {
      this.materialize(run);
      this.transition(run, 'creating');
      const container = await backend.create(this.source(run), id);
      this.transition(run, 'created', { container_id: container });
      run = this.get(session, id);
      await backend.start(container, this.source(run), id);
      await backend.ready(container, id);
      this.transition(run, 'exec_creating');
      const exec = await backend.exec(container, id, run.command, run.cwd);
      this.transition(run, 'launching', { exec_id: exec });
      await backend.launch(exec);
      this.transition(run, 'running');
      run = this.get(session, id);
    } else if (run.state === 'launching' && run.container_id && run.exec_id) {
      const actual = await backend.status(run.container_id, id, run.exec_id);
      if (!actual.running) {
        await this.finish(
          run,
          'interrupted',
          null,
          'Launch acknowledgment was not durably observed',
        );
        return;
      }
      this.transition(run, 'running');
    } else if (run.state === 'finishing') {
      await this.finish(
        run,
        run.cancelled ? 'cancelled' : run.exit_code === 0 ? 'succeeded' : 'failed',
        run.exit_code,
        run.error,
      );
      return;
    } else if (run.state !== 'running') {
      await this.finish(
        run,
        'interrupted',
        null,
        'Restart interrupted provisioning; command was not replayed',
      );
      return;
    }
    while (!this.closing) {
      run = this.get(session, id);
      if (run.cancelled) {
        await this.finish(run, 'cancelled', null, 'Cancellation requested');
        return;
      }
      if (Date.now() >= run.deadline) {
        await this.finish(run, 'timed_out', null, 'Command runtime limit exceeded');
        return;
      }
      if (!run.container_id || !run.exec_id) throw new Error('Missing execution identity');
      const actual = await backend.status(run.container_id, id, run.exec_id);
      const logs = await backend.logs(run.container_id, id);
      const before = Buffer.from(run.output, 'base64'),
        after = Buffer.from(logs.content, 'base64');
      if (!after.subarray(0, before.length).equals(before)) {
        await this.finish(
          run,
          'output_limited',
          actual.running ? null : actual.exit,
          'Command rewrote its captured output',
        );
        return;
      }
      if (after.length > before.length)
        this.store.transaction(() => {
          this.store.db
            .prepare('UPDATE command_runs SET output=? WHERE id=?')
            .run(logs.content, id);
          this.store.event(session, 'command.output', {
            run_id: id,
            offset: before.length,
            bytes: after.length - before.length,
          });
        });
      if (logs.bytes > COMMAND_LIMITS.outputBytes) {
        await this.finish(
          this.get(session, id),
          'output_limited',
          actual.running ? null : actual.exit,
          'Command output limit exceeded',
        );
        return;
      }
      if (!actual.running) {
        if (actual.exit === null) throw new Error('Missing exit outcome');
        const artifact = this.artifacts.prepare(
          session,
          JSON.stringify({ encoding: 'base64', data: logs.content }),
        );
        this.store.transaction(() => {
          artifact.commit();
          this.store.db
            .prepare(
              "UPDATE command_runs SET state='finishing',exit_code=?,result_artifact=? WHERE id=?",
            )
            .run(actual.exit, artifact.id, id);
          this.store.event(session, 'command.finishing', { run_id: id, exit_code: actual.exit });
        });
        await this.finish(
          this.get(session, id),
          actual.exit === 0 ? 'succeeded' : 'failed',
          actual.exit,
          null,
        );
        return;
      }
      await delay(100);
    }
  }
  private async finish(
    run: CommandRun,
    state: string,
    exit: number | null,
    error: string | null,
  ): Promise<void> {
    await this.executor!.cleanup(run.id);
    // Workspace is mounted read-only; command changes remain disposable. Never import shell edits.
    try {
      this.workspaces.verify(run.session_id, run.id);
    } catch (cause) {
      if (
        !(cause instanceof ServiceError) ||
        !['workspace_changed', 'workspace_conflict', 'unsafe_path'].includes(cause.code)
      )
        throw cause;
      state = 'failed';
      error = 'Workspace changed during command; its edits were preserved';
    }
    const current = this.get(run.session_id, run.id);
    if (current.cancelled) state = 'cancelled';
    this.transition(current, state, { exit_code: exit, error });
    this.workspaces.unlock(run.session_id, run.id);
    rmSync(this.source(run), { recursive: true, force: true });
  }
  logs(session: string, id: string, offset: number): unknown {
    integer(offset, 'offset');
    const run = this.get(session, id),
      data = Buffer.from(run.output, 'base64'),
      page = data.subarray(offset, offset + 8192);
    if (offset > data.length)
      throw new ServiceError('invalid_cursor', 'Offset is ahead of captured output', 400);
    return {
      run_id: id,
      state: run.state,
      offset,
      data: page.toString('base64'),
      text: page.toString('utf8'),
      next_offset: offset + page.length,
      complete: commandTerminal(run.state) && offset + page.length === data.length,
    };
  }
  cancel(session: string, id: string, request: string, authorize: () => void): CommandRun {
    const result = this.store.request('command-cancel:' + session, request, { id }, () => {
      authorize();
      const run = this.get(session, id);
      if (!commandTerminal(run.state)) {
        this.store.db.prepare('UPDATE command_runs SET cancelled=1 WHERE id=?').run(id);
        this.store.event(session, 'command.cancellation_requested', { run_id: id });
      }
      return this.get(session, id);
    });
    this.follow(id, session);
    return result;
  }
  cancelAttempt(attempt: string): void {
    for (const row of this.store.db
      .prepare('SELECT id,session_id FROM command_runs WHERE attempt_id=?')
      .all(attempt))
      this.cancel(
        String(row.session_id),
        String(row.id),
        'attempt:' + attempt + ':' + row.id,
        () => {},
      );
  }
  recover(): void {
    for (const row of this.store.db
      .prepare(
        "SELECT * FROM command_runs WHERE state NOT IN ('succeeded','failed','cancelled','timed_out','output_limited','interrupted')",
      )
      .all() as unknown as CommandRun[]) {
      if (this.workspaces.root) this.workspaces.hold(row.session_id, row.id);
      if (!this.executor || !this.workspaces.root) {
        this.transition(row, 'outcome_unknown', {
          resume_state: row.resume_state ?? row.state,
          error: 'Executor unavailable',
        });
        continue;
      }
      if (row.state !== 'outcome_unknown') this.follow(row.id, row.session_id);
    }
  }
  reconcile(session: string, id: string): CommandRun {
    const run = this.get(session, id);
    if (run.state === 'outcome_unknown') {
      if (
        !this.executor ||
        this.executor.engineId !== run.engine_id ||
        this.executor.profileDigest !== run.profile_digest
      )
        throw new ServiceError(
          'executor_unavailable',
          'Restore the original executor/profile before reconciliation',
        );
      this.transition(run, run.resume_state ?? 'interrupted', { error: null });
      this.follow(id, session);
    }
    return this.get(session, id);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.jobs.values());
  }
}
