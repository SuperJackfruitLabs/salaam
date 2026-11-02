// Durable jobs, their recurring schedules and occurrences, and the operator inbox.
import { ServiceError, integer, object, readJson, string } from '../core/index.js';
import type { JobWork, OperatorInbox, RecurringWork } from '../tasks/index.js';
import { send, type RouteContext } from './router.js';

export interface JobsService {
  readonly jobs: JobWork;
  readonly recurring: RecurringWork;
  readonly inbox: OperatorInbox;
}

const INBOX_FIELDS = ['client_id', 'token', 'request_id', 'expected_revision'];

/** The `offset` query parameter, 0 when absent. */
const offsetOf = (url: URL): number =>
  integer(Number(url.searchParams.get('offset') ?? 0), 'offset');

export class JobsController {
  constructor(private readonly s: JobsService) {}

  occurrence({ res, params }: RouteContext<'occurrence'>): void {
    send(res, 200, this.s.jobs.occurrence(params.occurrence));
  }

  inboxList({ res, url }: RouteContext): void {
    send(
      res,
      200,
      this.s.inbox.list(offsetOf(url), url.searchParams.get('session_id') ?? undefined),
    );
  }

  inboxItem({ res, params }: RouteContext<'item'>): void {
    send(res, 200, this.s.inbox.get(params.item));
  }

  async inboxAck({ req, res, params }: RouteContext<'item'>): Promise<void> {
    const body = object(await readJson(req));
    if (Object.keys(body).some((k) => !INBOX_FIELDS.includes(k)))
      throw new ServiceError('invalid_field', 'Unexpected inbox field', 400);
    send(
      res,
      200,
      this.s.inbox.ack(
        params.item,
        string(body.request_id, 'request_id', 128),
        integer(body.expected_revision, 'expected_revision'),
        {
          client_id: string(body.client_id, 'client_id', 128),
          token: string(body.token, 'token', 128),
        },
      ),
    );
  }

  inboxNotFound(): never {
    throw new ServiceError('not_found', 'Inbox route not found', 404);
  }

  schedules({ res, url }: RouteContext): void {
    send(res, 200, this.s.recurring.list(offsetOf(url)));
  }

  scheduleOccurrences({ res, url, params }: RouteContext<'schedule'>): void {
    const offset = offsetOf(url);
    send(res, 200, this.s.recurring.occurrences(params.schedule, offset));
  }

  schedule({ res, url, params }: RouteContext<'schedule'>): void {
    offsetOf(url);
    send(res, 200, this.s.recurring.view(params.schedule));
  }

  /** POST /v1/schedules creates one; /:id/update and /:id/run change or trigger it. */
  async changeSchedule({ req, res, url, parts }: RouteContext): Promise<void> {
    offsetOf(url);
    const body = object(await readJson(req));
    const allowed = [
      'client_id',
      'token',
      'request_id',
      'expected_revision',
      ...(parts.length === 2
        ? ['task_id', 'name', 'max_steps', 'compact', 'schedule']
        : parts[3] === 'run'
          ? ['occurrence_key']
          : ['schedule', 'state']),
    ];
    if (Object.keys(body).some((k) => !allowed.includes(k)))
      throw new ServiceError(
        'invalid_field',
        'Unexpected schedule field; triggers cannot change template authority',
        400,
      );
    const actor = {
        client_id: string(body.client_id, 'client_id', 128),
        token: string(body.token, 'token', 128),
      },
      request = string(body.request_id, 'request_id', 128),
      expected = integer(body.expected_revision, 'expected_revision');
    const result =
      parts.length === 2
        ? this.s.recurring.create(
            string(body.task_id, 'task_id', 128),
            request,
            expected,
            string(body.name, 'name', 256),
            integer(body.max_steps, 'max_steps'),
            body.compact as boolean,
            body.schedule,
            actor,
          )
        : parts[3] === 'run'
          ? this.s.recurring.trigger(
              parts[2]!,
              request,
              expected,
              string(body.occurrence_key, 'occurrence_key', 128),
              actor,
            )
          : this.s.recurring.update(parts[2]!, request, expected, body.schedule, body.state, actor);
    send(res, parts[3] === 'run' ? 202 : 200, result);
  }

  scheduleNotFound({ url }: RouteContext): never {
    offsetOf(url);
    throw new ServiceError('not_found', 'Schedule route not found', 404);
  }

  jobList({ res, url }: RouteContext): void {
    send(res, 200, this.s.jobs.list(offsetOf(url)));
  }

  job({ res, params }: RouteContext<'job'>): void {
    send(res, 200, this.s.jobs.view(params.job));
  }

  /** POST /v1/jobs creates one; /:id/run triggers it and /:id/cancel cancels it. */
  async changeJob({ req, res, parts }: RouteContext): Promise<void> {
    const body = object(await readJson(req));
    const allowed = new Set([
      'client_id',
      'token',
      'request_id',
      'expected_revision',
      ...(parts.length === 2
        ? ['task_id', 'name', 'max_steps', 'compact']
        : parts[3] === 'run'
          ? ['occurrence_key']
          : []),
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key)))
      throw new ServiceError(
        'invalid_field',
        'Unexpected job field; triggers cannot change reviewed authority',
        400,
      );
    const controller = {
      client_id: string(body.client_id, 'client_id', 128),
      token: string(body.token, 'token', 128),
    };
    const request = string(body.request_id, 'request_id', 128),
      expected = integer(body.expected_revision, 'expected_revision');
    if (parts.length === 2) {
      const compact = body.compact ?? false;
      if (typeof compact !== 'boolean')
        throw new ServiceError('invalid_field', 'compact must be boolean', 400);
      const job = this.s.jobs.create(
        string(body.task_id, 'task_id', 128),
        request,
        expected,
        string(body.name, 'name', 256),
        integer(body.max_steps, 'max_steps'),
        compact,
        controller,
      );
      send(res, 201, this.s.jobs.view(job.id));
    } else if (parts[3] === 'run')
      send(
        res,
        202,
        this.s.jobs.trigger(
          parts[2]!,
          request,
          expected,
          string(body.occurrence_key, 'occurrence_key', 128),
          controller,
        ),
      );
    else send(res, 200, await this.s.jobs.cancel(parts[2]!, request, expected, controller));
  }

  jobNotFound(): never {
    throw new ServiceError('not_found', 'Job route not found', 404);
  }
}
