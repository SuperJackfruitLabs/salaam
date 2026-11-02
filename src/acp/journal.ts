import {
  mkdirSync,
  existsSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonical,
  ServiceError,
  type Controller,
  type SessionSnapshot,
  call,
} from '../core/index.js';
interface Record {
  request_id: string;
  session: string;
  text: string;
  expected_revision: number;
  continues_attempt_id?: string;
  receipt?: { id: string; attempt_id: string };
}
/** Transport request IDs are ephemeral. This journal binds logical submission UUIDs. */
export class AcpJournal {
  private dir: string;
  constructor(state: string) {
    this.dir = join(state, 'acp-requests');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const parent = openSync(state, 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  private save(value: Record): void {
    const temporary = join(this.dir, randomUUID() + '.tmp');
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(this.dir, value.request_id + '.json'));
    const directory = openSync(this.dir, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  prepare(
    session: string,
    request: string,
    text: string,
    revision: number,
    continues?: string,
  ): Record {
    if (!/^[a-f0-9-]{36}$/i.test(request))
      throw new ServiceError('invalid_request_id', 'Logical request ID must be a UUID', 400);
    const path = join(this.dir, request + '.json');
    const value: Record = {
      session,
      request_id: request,
      text,
      expected_revision: revision,
      ...(continues ? { continues_attempt_id: continues } : {}),
    };
    if (existsSync(path)) {
      const prior = JSON.parse(readFileSync(path, 'utf8')) as Record;
      if (
        canonical({ ...prior, receipt: null, expected_revision: 0 }) !==
        canonical({ ...value, receipt: null, expected_revision: 0 })
      )
        throw new ServiceError(
          'request_conflict',
          'Logical request ID already binds another instruction',
        );
      return prior;
    }
    this.save(value);
    return value;
  }
  records(session: string): Record[] {
    return readdirSync(this.dir)
      .filter((n) => /^[a-f0-9-]{36}\.json$/i.test(n))
      .map((n) => JSON.parse(readFileSync(join(this.dir, n), 'utf8')) as Record)
      .filter((r) => r.session === session);
  }
  pending(session: string): Record[] {
    return this.records(session).filter((r) => !r.receipt);
  }
  async dispatch(socket: string, value: Record, controller: Controller) {
    if (value.receipt) return value.receipt;
    for (let retry = 0; ; retry++) {
      try {
        const receipt = await call<{ id: string; attempt_id: string }>(
          socket,
          `/v1/sessions/${value.session}/submissions`,
          {
            ...controller,
            request_id: value.request_id,
            text: value.text,
            expected_revision: value.expected_revision,
            ...(value.continues_attempt_id
              ? { continues_attempt_id: value.continues_attempt_id }
              : {}),
          },
        );
        value.receipt = receipt;
        this.save(value);
        return receipt;
      } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== 'revision_conflict' || retry >= 20)
          throw error;
        value.expected_revision = (
          await call<SessionSnapshot>(socket, `/v1/sessions/${value.session}/snapshot`)
        ).revision;
        this.save(value);
      }
    }
  }
}
