// A session's turns: submitting a prompt, steering the running turn, cancelling turns and
// attempts, probing the worker, and following the session's events.
import { ServiceError, integer, object, readJson, string } from '../core/index.js';
import {
  MAX_IMAGES,
  PASTED_IMAGE_LIMIT,
  expandPrompt,
  pastedImages,
  storeImages,
  type PromptImage,
  type Supervisor,
  type TurnCancellations,
} from '../runtime/index.js';
import type { CodingWork } from '../coding/index.js';
import type { ManagedWork } from '../execution/index.js';
import type { Store } from '../store/index.js';
import type { ChildWork, ExternalWork } from '../workers/index.js';
import { streamEvents } from './events.js';
import { send, type RouteContext } from './router.js';

/** A prompt with the most pasted images it may carry, as base64, plus its text. */
export const SUBMISSION_BODY_LIMIT =
  Math.ceil((MAX_IMAGES * PASTED_IMAGE_LIMIT * 4) / 3) + 2 * 1024 * 1024;
/** The most characters of a submitted prompt, and of a steering message. */
const PROMPT_TEXT_LIMIT = 256 * 1024;
const STEER_TEXT_LIMIT = 65536;

export interface SubmissionsService {
  readonly store: Store;
  readonly supervisor: Supervisor;
  readonly managed: ManagedWork;
  readonly coding: CodingWork;
  readonly children: ChildWork;
  readonly external: ExternalWork;
  readonly cancellations: TurnCancellations;
}

const controllerOf = (body: Record<string, unknown>) => ({
  client_id: string(body.client_id, 'client_id', 128),
  token: string(body.token, 'token', 128),
});

export class SubmissionsController {
  constructor(private readonly s: SubmissionsService) {}

  async submit({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    // Room for pasted images; every other route keeps the 1 MiB limit.
    const body = object(await readJson(req, SUBMISSION_BODY_LIMIT));
    // Any desk session, read-only or coding; board sessions get exactly what was typed.
    const local = this.s.store.localWorkspace(id);
    let text = string(body.text, 'text', PROMPT_TEXT_LIMIT);
    let images: PromptImage[] = [];
    if (!local && body.images !== undefined)
      throw new ServiceError('invalid_field', 'Only a local session takes pasted images', 400);
    // Desk prompts attach their @mentions (Phase 3b) and pasted images; board work never
    // reads the tree here.
    if (local) {
      if (body.confirm_sensitive !== undefined && typeof body.confirm_sensitive !== 'boolean')
        throw new ServiceError('invalid_field', 'Invalid confirm_sensitive flag', 400);
      ({ text, images } = expandPrompt(
        this.s.store.session(id).cwd,
        text,
        body.confirm_sensitive === true,
        pastedImages(body.images),
      ));
    }
    const submission = this.s.store.accept(
      id,
      string(body.request_id, 'request_id', 128),
      integer(body.expected_revision, 'expected_revision'),
      text,
      controllerOf(body),
      body.continues_attempt_id === undefined
        ? null
        : string(body.continues_attempt_id, 'continues_attempt_id', 128),
    );
    // Same tick as the acceptance, so dispatch cannot claim the submission without them.
    storeImages(this.s.store.db, submission.id, images);
    send(res, 202, submission);
  }

  async steer({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const body = object(await readJson(req));
    send(
      res,
      200,
      await this.s.supervisor.steer(
        params.session,
        string(body.request_id, 'request_id', 128),
        string(body.text, 'text', STEER_TEXT_LIMIT),
        controllerOf(body),
      ),
    );
  }

  cancellations({ res, url, params }: RouteContext<'session'>): void {
    const id = params.session;
    const request = url.searchParams.get('request_id');
    send(
      res,
      200,
      request
        ? this.s.cancellations.get(id, string(request, 'request_id', 128))
        : this.s.cancellations.list(id),
    );
  }

  async cancelTurn({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const body = object(await readJson(req));
    send(
      res,
      202,
      this.s.cancellations.begin(
        params.session,
        string(body.request_id, 'request_id', 128),
        body.target_request_id == null
          ? null
          : string(body.target_request_id, 'target_request_id', 128),
        controllerOf(body),
      ),
    );
  }

  attempt({ res, params }: RouteContext<'attempt'>): void {
    send(res, 200, this.s.store.attempt(params.attempt));
  }

  /** The receipt answers at once; the worker, child or external run stops after it. */
  async cancelAttempt({ req, res, params }: RouteContext<'attempt'>): Promise<void> {
    const s = this.s;
    const body = object(await readJson(req));
    const attempt = params.attempt;
    const receipt = s.managed.cancel(
      attempt,
      string(body.request_id, 'request_id', 128),
      integer(body.expected_revision, 'expected_revision'),
      controllerOf(body),
    );
    s.coding.cancelAttempt(attempt);
    const owned = s.children.owned(s.store.attempt(attempt).session_id);
    void (
      owned && s.store.workerBoundary.view(owned.id).binding.external
        ? s.external.cancel(owned)
        : s.children.cancelOwned(attempt).then(() => s.supervisor.cancelAttempt(attempt))
    ).catch((error) => s.supervisor.failControl(s.store.attempt(attempt).session_id, error));
    send(res, 202, receipt);
  }

  async probe({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    this.s.store.authorizeControl(id, controllerOf(body));
    if (body.nested !== undefined && typeof body.nested !== 'boolean')
      throw new ServiceError('invalid_field', 'Invalid nested flag', 400);
    send(res, 200, await this.s.supervisor.probe(id, body.nested === true));
  }

  /** Server-sent events after a cursor, which may not be ahead of the session. */
  events({ req, res, url, params }: RouteContext<'session'>): void {
    const id = params.session;
    const raw = url.searchParams.get('after') ?? '0';
    if (!/^\d+$/.test(raw)) throw new ServiceError('invalid_cursor', 'Invalid event cursor', 400);
    const after = integer(Number(raw), 'after');
    if (after > this.s.store.session(id).seq)
      throw new ServiceError('invalid_cursor', 'Cursor is ahead of session', 400);
    streamEvents(this.s.store, this.s.supervisor, req, res, id, after);
  }
}
