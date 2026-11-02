import { randomUUID } from 'node:crypto';
import { call, type Approval } from '../../core/index.js';
import { Outbox } from '../../tui/index.js';
import type { CliContext } from './context.js';

export const APPROVALS_HELP = `salaam approvals list [--session SESSION_ID]
salaam approvals inspect APPROVAL_ID
salaam approvals approve APPROVAL_ID --digest DIGEST --revision N [--request-id UUID]
salaam approvals deny APPROVAL_ID --digest DIGEST --revision N [--request-id UUID]

Inspect the operation, then supply its reviewed digest and approval revision.`;
export const OPERATIONS_HELP = `salaam operations inspect OPERATION_ID
salaam operations reconcile OPERATION_ID [--request-id ID]
salaam operations resolve OPERATION_ID --digest DIGEST --revision N
                          --outcome succeeded|failed_definite --evidence TEXT
                          [--request-id ID]

Reconciliation checks status without resending an effect. Resolution records
an explicit operator attestation for an unknown outcome.`;
export const CHILDREN_HELP = `salaam children inspect CHILD_ID
salaam children result CHILD_ID
salaam children ack CHILD_ID --result RESULT_ID [--request-id ID]

Reading a result leaves it available. Acknowledgment is explicit and idempotent.
List a parent's children with salaam session children SESSION_ID.`;

/** salaam children: child results. */
export async function childrenCommand(ctx: CliContext): Promise<boolean> {
  const { option, socket, group, verb, id } = ctx;
  if (group === 'children' && id && ['inspect', 'result', 'ack'].includes(verb ?? '')) {
    if (verb === 'ack') {
      const result_id = option('--result');
      if (!result_id) throw new Error('Supply the result ID with --result');
      console.log(
        JSON.stringify(
          await call(socket, `/v1/children/${id}/ack`, {
            result_id,
            request_id: option('--request-id') ?? randomUUID(),
          }),
          null,
          2,
        ),
      );
    } else
      console.log(
        JSON.stringify(
          await call(socket, `/v1/children/${id}${verb === 'result' ? '/result' : ''}`),
          null,
          2,
        ),
      );
    return true;
  }
  return false;
}
/** salaam approvals: list, inspect and decide. */
export async function approvalsCommand(ctx: CliContext): Promise<boolean> {
  const { option, state, socket, group, verb, id } = ctx;
  if (group === 'approvals' && verb === 'list') {
    const session = option('--session');
    console.log(
      JSON.stringify(
        await call(
          socket,
          '/v1/approvals' + (session ? '?session=' + encodeURIComponent(session) : ''),
        ),
        null,
        2,
      ),
    );
    return true;
  }
  if (group === 'approvals' && id && ['inspect', 'approve', 'deny'].includes(verb ?? '')) {
    const approval = await call<Approval>(socket, `/v1/approvals/${id}`);
    if (verb === 'inspect') {
      console.log(
        JSON.stringify(
          { approval, operation: await call(socket, `/v1/operations/${approval.operation_id}`) },
          null,
          2,
        ),
      );
      return true;
    }
    const binding = option('--digest');
    const revision = Number(option('--revision'));
    if (!binding || !Number.isSafeInteger(revision))
      throw new Error('Supply the reviewed --digest and --revision from approvals inspect');
    const outbox = new Outbox(state, approval.session_id);
    const record = outbox.enqueueDecision(
      id,
      binding,
      revision,
      verb === 'approve' ? 'approve' : 'deny',
      option('--request-id'),
    );
    console.log(JSON.stringify({ request_id: record.request_id }));
    await outbox.flush(socket, approval.session_id);
    console.log(JSON.stringify(await call(socket, `/v1/approvals/${id}`), null, 2));
    return true;
  }
  return false;
}
/** salaam operations: inspect, reconcile and resolve effect outcomes. */
export async function operationsCommand(ctx: CliContext): Promise<boolean> {
  const { option, socket, group, verb, id } = ctx;
  if (group === 'operations' && id && ['inspect', 'reconcile', 'resolve'].includes(verb ?? '')) {
    if (verb === 'inspect') {
      console.log(JSON.stringify(await call(socket, `/v1/operations/${id}`), null, 2));
      return true;
    }
    if (verb === 'reconcile') {
      console.log(
        JSON.stringify(
          await call(socket, `/v1/operations/${id}/reconcile`, {
            request_id: option('--request-id') ?? randomUUID(),
          }),
          null,
          2,
        ),
      );
      return true;
    }
    const binding = option('--digest');
    const revision = Number(option('--revision'));
    const evidence = option('--evidence');
    const outcome = option('--outcome');
    if (
      !binding ||
      !Number.isSafeInteger(revision) ||
      !evidence ||
      !['succeeded', 'failed_definite'].includes(outcome ?? '')
    )
      throw new Error(
        'Supply reviewed --digest --revision --evidence and --outcome succeeded|failed_definite',
      );
    const request_id = option('--request-id') ?? randomUUID();
    console.log(JSON.stringify({ request_id }));
    console.log(
      JSON.stringify(
        await call(socket, `/v1/operations/${id}/resolution`, {
          request_id,
          expected_revision: revision,
          operation_digest: binding,
          evidence,
          outcome,
        }),
        null,
        2,
      ),
    );
    return true;
  }
  return false;
}
