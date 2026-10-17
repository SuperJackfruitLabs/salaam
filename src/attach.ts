import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { terminalInput } from './input.js';
import { call } from './transport.js';
import {
  ServiceError,
  canonical,
  type ControlLease,
  type Controller,
  type DurableEvent,
  type SessionSnapshot,
} from './protocol.js';

interface Pending {
  created_at: number;
  request_id: string;
  expected_revision: number;
  text: string;
  continues_attempt_id?: string;
  command?:
    | {
        kind: 'decision';
        approval_id: string;
        operation_digest: string;
        expected_revision: number;
        decision: 'approve' | 'deny';
      }
    | { kind: 'cancel'; attempt_id: string };
}
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Acceptance can be retried after a killed terminal or a lost HTTP response. */
export class Outbox {
  readonly dir: string;
  constructor(state: string, session: string) {
    if (!/^[a-f0-9-]{36}$/i.test(session)) throw new Error('Invalid session ID');
    const root = join(state, 'outbox');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.dir = join(root, session);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    syncDirectory(state);
    syncDirectory(root);
  }
  private save(record: Pending): void {
    const path = join(this.dir, record.request_id + '.json');
    const temporary = path + '.' + randomUUID() + '.tmp';
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(this.dir);
  }
  enqueue(text: string, revision: number, continues?: string): Pending {
    if (!text.trim() || text.length > 256 * 1024 || text.trimStart().startsWith('/'))
      throw new Error('Enter a plain instruction of at most 256 Ki characters');
    const created = this.records().reduce(
      (latest, record) => Math.max(latest, record.created_at + 1),
      Date.now(),
    );
    const record: Pending = {
      created_at: created,
      request_id: randomUUID(),
      expected_revision: revision,
      text,
      ...(continues ? { continues_attempt_id: continues } : {}),
    };
    this.save(record);
    return record;
  }
  enqueueDecision(
    approval: string,
    binding: string,
    revision: number,
    decision: 'approve' | 'deny',
    request: string = randomUUID(),
  ): Pending {
    if (
      !/^[a-f0-9-]{36}$/i.test(request) ||
      !/^[a-f0-9-]{36}$/i.test(approval) ||
      !/^[a-f0-9]{64}$/i.test(binding) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      throw new Error('Invalid decision identity or binding');
    const record: Pending = {
      created_at: Date.now(),
      request_id: request,
      expected_revision: revision,
      text: '',
      command: {
        kind: 'decision',
        approval_id: approval,
        operation_digest: binding,
        expected_revision: revision,
        decision,
      },
    };
    return this.enqueueCommand(record);
  }
  enqueueCancellation(attempt: string, revision: number, request: string = randomUUID()): Pending {
    if (!/^[a-f0-9-]{36}$/i.test(request) || !/^[a-f0-9-]{36}$/i.test(attempt))
      throw new Error('Invalid cancellation identity');
    const record: Pending = {
      created_at: Date.now(),
      request_id: request,
      expected_revision: revision,
      text: '',
      command: { kind: 'cancel', attempt_id: attempt },
    };
    return this.enqueueCommand(record);
  }
  private enqueueCommand(record: Pending): Pending {
    const records = this.records();
    const prior = records.find((prior) => prior.request_id === record.request_id);
    if (prior) {
      if (canonical({ ...prior, created_at: 0 }) !== canonical({ ...record, created_at: 0 }))
        throw new Error('Pending request ID already binds different input');
      return prior;
    }
    record.created_at = records.reduce(
      (latest, prior) => Math.max(latest, prior.created_at + 1),
      Date.now(),
    );
    this.save(record);
    return record;
  }
  records(): Pending[] {
    return readdirSync(this.dir)
      .filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name))
      .map((name) => JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Pending)
      .sort((a, b) => a.created_at - b.created_at);
  }
  async flush(socket: string, session: string, controller?: Controller): Promise<void> {
    for (const record of this.records()) {
      if (record.command?.kind !== 'decision' && !controller) continue;
      // Refresh only after a definite rejection. On a transport/500 failure the
      // original request remains byte-for-byte retryable on the next attach.
      for (let retry = 0; ; retry++) {
        try {
          if (record.command?.kind === 'decision')
            await call(socket, `/v1/approvals/${record.command.approval_id}/decision`, {
              ...record.command,
              request_id: record.request_id,
            });
          else if (record.command?.kind === 'cancel')
            await call(socket, `/v1/attempts/${record.command.attempt_id}/cancel`, {
              request_id: record.request_id,
              expected_revision: record.expected_revision,
              ...controller,
            });
          else
            await call(socket, `/v1/sessions/${session}/submissions`, { ...record, ...controller });
          unlinkSync(join(this.dir, record.request_id + '.json'));
          syncDirectory(this.dir);
          break;
        } catch (error) {
          if (
            error instanceof ServiceError &&
            ([
              'reserved_command',
              'invalid_continuation',
              'invalid_field',
              'approval_stale',
              'approval_mismatch',
              'binding_changed',
              'attempt_settled',
            ].includes(error.code) ||
              (record.command && error.code === 'not_found'))
          ) {
            const rejected = join(this.dir, record.request_id + '.rejected.json');
            renameSync(join(this.dir, record.request_id + '.json'), rejected);
            syncDirectory(this.dir);
            throw new Error(`${error.message}; rejected input saved at ${rejected}`);
          }
          if (
            record.command?.kind === 'decision' ||
            !(error instanceof ServiceError) ||
            error.code !== 'revision_conflict' ||
            retry >= 20
          )
            throw error;
          const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${session}/snapshot`);
          record.expected_revision = snapshot.revision;
          this.save(record);
        }
      }
    }
  }
}

export async function acquireControl(
  socket: string,
  id: string,
  client: string,
  takeover = false,
): Promise<ControlLease> {
  const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
  const body = {
    request_id: randomUUID(),
    client_id: client,
    action: takeover ? 'takeover' : 'acquire',
    expected_epoch: snapshot.control.epoch,
  };
  // A lost response must recover the same lease rather than acquire another.
  for (let retry = 0; ; retry++) {
    try {
      return await call<ControlLease>(socket, `/v1/sessions/${id}/control`, body);
    } catch (error) {
      if (error instanceof ServiceError || retry >= 2) throw error;
    }
  }
}

export interface Feed {
  close(): void;
  done: Promise<void>;
}
/** One connection; callers retain the last durable cursor across reconnects. */
export function subscribe(
  socketPath: string,
  id: string,
  after: number,
  onEvent: (event: DurableEvent) => void,
): Feed {
  let stop!: () => void;
  const done = new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, path: `/v1/sessions/${id}/events?after=${after}` }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('Event stream rejected: ' + res.statusCode));
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) {
          req.destroy(new Error('Event packet too large'));
          return;
        }
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const packet = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = packet.split('\n').find((line) => line.startsWith('data: '));
          // Previews have no durable id. Final text comes from committed events.
          if (data && packet.startsWith('id: ')) {
            try {
              onEvent(JSON.parse(data.slice(6)) as DurableEvent);
            } catch (error) {
              req.destroy(error as Error);
              return;
            }
          }
        }
      });
      res.on('error', reject);
      res.on('end', resolve);
      res.on('close', resolve);
    });
    req.setTimeout(35000, () => req.destroy(new Error('Event stream stalled')));
    req.on('error', reject);
    req.end();
    stop = () => {
      req.destroy();
      resolve();
    };
  });
  return { done, close: () => stop() };
}

export async function attach(
  state: string,
  id: string,
  options: { observe?: boolean; takeover?: boolean } = {},
): Promise<void> {
  const socket = join(state, 'operator.sock');
  const client = randomUUID();
  let lease = options.observe
    ? undefined
    : await acquireControl(socket, id, client, options.takeover);
  let controller = lease ? { client_id: client, token: lease.token } : undefined;
  if (controller) await call(socket, `/v1/sessions/${id}/resume`, controller);
  const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
  let cursor = snapshot.seq;
  let revision = snapshot.revision;
  let terminal: ReturnType<typeof terminalInput> | undefined;
  const output = (text: string): void => {
    if (terminal) terminal.print(text);
    else process.stdout.write(text + '\n');
  };
  // Strip terminal control characters from model/user content, retaining LF/TAB.
  const safe = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  for (const message of snapshot.messages)
    output(`${message.role}> ${safe(message.text)}${message.truncated ? ' [truncated]' : ''}`);
  if (snapshot.history_truncated) output('[Showing recent transcript history.]');
  for (const attempt of snapshot.attempts.filter((a) => !['completed', 'failed'].includes(a.state)))
    output(`[${attempt.id}: ${attempt.state}${attempt.resolved_by ? ', continued' : ''}]`);
  for (const approval of snapshot.approvals.filter((a) => a.state === 'pending')) {
    const op = snapshot.operations.find((op) => op.id === approval.operation_id);
    output(
      `[approval ${approval.id}] ${safe(op?.target ?? '')} ${safe(op?.value ?? '')}${op?.value_truncated ? ' [truncated; inspect full operation]' : ''} version=${safe(op?.target_version ?? '')} digest=${approval.operation_digest} revision=${approval.revision}`,
    );
  }
  for (const child of snapshot.children.filter((child) => child.result_id && !child.acknowledged))
    output(
      `[child result ${child.id} result=${child.result_id} state=${child.state}; available until acknowledged]`,
    );
  for (const op of snapshot.operations.filter((op) => op.state === 'outcome_unknown'))
    output(`[operation ${op.id}: outcome_unknown; inspect and reconcile before continuing]`);
  output(
    `Attached to ${id} (${controller ? 'controller' : 'observer'}). Ctrl-D or Ctrl-C detaches. :help lists decision and cancel commands.`,
  );
  const outbox = new Outbox(state, id);
  let active = true;
  let feed: Feed | undefined;
  let queue = Promise.resolve();
  const flush = () => {
    queue = queue
      .then(async () => {
        await outbox.flush(socket, id, controller);
      })
      .catch((error) => output(`[input delivery: ${(error as Error).message}]`));
  };
  flush();
  const renew = setInterval(() => {
    flush();
    if (!lease || !controller) return;
    const old = lease;
    void call<ControlLease>(socket, `/v1/sessions/${id}/control`, {
      ...controller,
      request_id: randomUUID(),
      action: 'renew',
      expected_epoch: old.epoch,
    })
      .then((next) => {
        lease = next;
      })
      .catch((error) => {
        if (
          error instanceof ServiceError &&
          ['control_required', 'control_conflict'].includes(error.code)
        ) {
          controller = undefined;
          output('[Controller lease lost; observing. Reattach with --takeover to take control.]');
        }
      });
  }, 5000);
  const reconnect = (async () => {
    while (active) {
      feed = subscribe(socket, id, cursor, (event) => {
        if (event.seq <= cursor) return;
        const payload = event.payload as {
          attempt_id?: string;
          text?: string;
          error?: string;
          truncated?: boolean;
          approval_id?: string;
          operation_digest?: string;
          target?: string;
          value?: string;
          target_version?: string;
          operation_id?: string;
        };
        if (event.kind === 'attempt.completed')
          output(
            `assistant> ${safe(payload.text ?? '')}${payload.truncated ? ' [truncated]' : ''}`,
          );
        else if (
          [
            'attempt.running',
            'attempt.interrupted',
            'attempt.failed',
            'attempt.cancelled',
            'attempt.cancel_requested',
          ].includes(event.kind)
        )
          output(
            `[${payload.attempt_id}: ${event.kind.slice(8)}${payload.error ? ': ' + safe(payload.error) : ''}]`,
          );
        else if (event.kind === 'child.result_available')
          output(`[child result available ${safe(JSON.stringify(event.payload))}]`);
        else if (event.kind === 'approval.requested')
          output(
            `[approval ${payload.approval_id}] ${safe(payload.target ?? '')} ${safe(payload.value ?? '')} version=${safe(payload.target_version ?? '')} digest=${payload.operation_digest} revision=1`,
          );
        else if (
          event.kind.startsWith('operation.') &&
          [
            'operation.succeeded',
            'operation.outcome_unknown',
            'operation.failed_definite',
          ].includes(event.kind)
        )
          output(
            `[${event.kind} ${payload.operation_id}${payload.error ? ': ' + safe(payload.error) : ''}]`,
          );
        cursor = event.seq;
        revision = event.seq;
      });
      try {
        await feed.done;
      } catch (error) {
        if (active) output(`[reconnecting: ${(error as Error).message}]`);
      }
      if (active) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  const acceptLine = (text: string) => {
    if (!text.trim()) return;
    const decision = /^:(approve|deny) ([a-f0-9-]{36}) ([a-f0-9]{64}) (\d+)$/.exec(text);
    if (decision) {
      outbox.enqueueDecision(
        decision[2]!,
        decision[3]!,
        Number(decision[4]),
        decision[1] === 'approve' ? 'approve' : 'deny',
      );
      flush();
      return;
    }
    const cancellation = /^:cancel ([a-f0-9-]{36})$/.exec(text);
    if (cancellation) {
      if (!controller) {
        output('[A controller lease is required to cancel.]');
        return;
      }
      outbox.enqueueCancellation(cancellation[1]!, revision);
      flush();
      return;
    }
    if (text.startsWith(':')) {
      output('Commands: :approve ID DIGEST REV | :deny ID DIGEST REV | :cancel ATTEMPT_ID');
      return;
    }
    if (text.trimStart().startsWith('/')) {
      output('[Pi slash commands are unavailable; enter a plain instruction.]');
      return;
    }
    if (!controller) {
      output('[Read-only attachment; use --takeover to submit.]');
      return;
    }
    try {
      outbox.enqueue(text, revision);
      flush();
    } catch (error) {
      output(`[Input not saved: ${(error as Error).message}]`);
    }
  };
  let detach!: () => void;
  await new Promise<void>((resolve) => {
    if (process.stdin.isTTY) {
      terminal = terminalInput(process.stdin, process.stdout, acceptLine, resolve);
      detach = () => terminal!.close();
    } else {
      // readline also splits U+2028/U+2029. Pipe input must use only LF so a
      // Unicode prompt cannot silently become multiple dispatched instructions.
      let buffer = '';
      process.stdin.setEncoding('utf8');
      const data = (chunk: string) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          acceptLine(buffer.slice(0, end).replace(/\r$/, ''));
          buffer = buffer.slice(end + 1);
        }
      };
      const end = () => {
        if (buffer) acceptLine(buffer);
        detach();
      };
      process.stdin.on('data', data);
      process.stdin.once('end', end);
      detach = () => {
        process.stdin.off('data', data);
        process.stdin.off('end', end);
        process.stdin.pause();
        resolve();
      };
    }
    process.once('SIGINT', detach);
    process.once('SIGTERM', detach);
  });
  active = false;
  clearInterval(renew);
  feed?.close();
  process.off('SIGINT', detach);
  process.off('SIGTERM', detach);
  await reconnect;
  await queue;
  if (lease && controller) {
    try {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      });
    } catch {}
  }
}
