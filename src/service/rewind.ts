// Going back in a desk session: undoing its last edits, its turn checkpoints, rewinding to one
// (forking the conversation), and reviewing what changed hunk by hunk.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError, object, readJson, string } from '../core/index.js';
import {
  applyUndo,
  reconcileUndo,
  reviewUndo,
  type LocalCoding,
  type ToolIdentity,
} from '../local/index.js';
import {
  forkPiSession,
  type RewindMode,
  type Supervisor,
  type TaskContext,
} from '../runtime/index.js';
import type { AgentPodAuthority } from '../agentpod/index.js';
import type { Store } from '../store/index.js';
import { send, type RouteContext } from './router.js';

export interface RewindService {
  readonly stateDir: string;
  readonly store: Store;
  readonly supervisor: Supervisor;
  readonly tasks: TaskContext;
  readonly localCoding: LocalCoding;
  readonly toolIdentity: ToolIdentity;
  readonly agentpod?: AgentPodAuthority;
}

/** The most bytes of a reviewed hunk's text or patch. */
const HUNK_LIMIT = 256 * 1024;

const ACTIVE_ATTEMPT_SQL =
  "SELECT 1 FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running')";

const controllerOf = (body: Record<string, unknown>) => ({
  client_id: string(body.client_id, 'client_id', 128),
  token: string(body.token, 'token', 128),
});

export class RewindController {
  constructor(private readonly s: RewindService) {}

  async reconcileUndo({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    send(
      res,
      200,
      reconcileUndo(this.s.store, id, controllerOf(body), () => this.s.supervisor.assertIdle(id)),
    );
  }

  undo({ res, params }: RouteContext<'session'>): void {
    send(res, 200, reviewUndo(this.s.store, params.session));
  }

  async applyUndo({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    send(
      res,
      200,
      applyUndo(
        this.s.store,
        id,
        string(body.request_id, 'request_id', 128),
        string(body.review_digest, 'review_digest', 128),
        controllerOf(body),
        () => {
          this.s.supervisor.assertIdle(id);
          if (this.s.store.db.prepare(ACTIVE_ATTEMPT_SQL).get(id))
            throw new ServiceError('session_busy', 'Wait for queued work before undo');
        },
        this.s.toolIdentity,
      ),
    );
  }

  checkpoints({ res, params }: RouteContext<'session'>): void {
    send(res, 200, { checkpoints: this.s.tasks.checkpoints!.list(params.session) });
  }

  reviewRewind({ res, url, params }: RouteContext<'session'>): void {
    const id = params.session;
    send(
      res,
      200,
      this.running(
        id,
        this.s.tasks.checkpoints!.reviewRewind(
          id,
          string(url.searchParams.get('attempt'), 'attempt', 128),
          string(url.searchParams.get('mode'), 'mode', 16) as RewindMode,
        ),
      ),
    );
  }

  async rewind({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const checkpoints = this.s.tasks.checkpoints!;
    if (this.s.agentpod)
      throw new ServiceError('admission_required', 'Managed station sessions cannot rewind');
    const body = object(await readJson(req));
    const request = string(body.request_id, 'request_id', 128);
    send(
      res,
      200,
      checkpoints.rewind(
        id,
        request,
        string(body.attempt_id, 'attempt_id', 128),
        string(body.mode, 'mode', 16) as RewindMode,
        string(body.review_digest, 'review_digest', 128),
        controllerOf(body),
        () => this.idle(id),
        (leaf, summary) =>
          this.s.store.forkLocal(
            id,
            request + ':fork',
            this.s.store.session(id).revision,
            controllerOf(body),
            (source, target) => {
              const dir = join(this.s.stateDir, 'workers', target, 'sessions');
              mkdirSync(dir, { recursive: true, mode: 0o700 });
              return forkPiSession(source.pi_session_file!, source.cwd, dir, target, {
                leaf,
                summary,
              });
            },
            { leaf },
          ),
      ),
    );
  }

  review({ res, params }: RouteContext<'session'>): void {
    const id = params.session;
    send(res, 200, { review: this.running(id, this.s.tasks.checkpoints!.review(id)) });
  }

  hunks({ res, url, params }: RouteContext<'session'>): void {
    const q = (name: string) => string(url.searchParams.get(name), name, 1024);
    send(res, 200, {
      hunks: this.s.tasks.checkpoints!.hunks(params.session, q('path'), q('base'), q('current')),
    });
  }

  async act({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const checkpoints = this.s.tasks.checkpoints!;
    const body = object(await readJson(req));
    const hunk =
      body.hunk === undefined
        ? undefined
        : {
            text: string(object(body.hunk).text, 'hunk.text', HUNK_LIMIT),
            patch: string(object(body.hunk).patch, 'hunk.patch', HUNK_LIMIT),
          };
    send(res, 200, {
      review: this.running(
        id,
        checkpoints.act(
          id,
          {
            action: string(body.action, 'action', 16) as 'accept' | 'revert',
            path: string(body.path, 'path', 1024),
            ...(hunk ? { hunk } : {}),
            base: string(body.base, 'base', 128),
            current: string(body.current, 'current', 128),
          },
          controllerOf(body),
          () => this.idle(id),
        ),
      ),
    });
  }

  /** Operator ruling 2026-10-31: background commands may keep writing; say so, do not block. */
  private running<T extends object | null>(id: string, value: T): T {
    return value && this.s.localCoding
      ? {
          ...value,
          background_running: this.s.localCoding.tasks(id).filter((t) => t.state === 'running')
            .length,
        }
      : value;
  }

  private idle(id: string): void {
    this.s.supervisor.assertIdle(id);
    if (this.s.store.db.prepare(ACTIVE_ATTEMPT_SQL).get(id))
      throw new ServiceError('session_busy', 'Wait for the current turn to finish');
  }
}
