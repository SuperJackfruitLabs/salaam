import type { SessionSnapshot } from '../../core/index.js';
import { usageInput } from '../client.js';
import { shortId } from '../theme.js';
import { modelLabel } from '../view-model.js';
import type { DocumentBlocks } from './blocks.js';

// The Context tab: the session's identity, inbox, workspace, jobs, team, task, facts, child work,
// usage and execution backend.

/** Everything the Context tab shows, top to bottom. */
export function contextLines(doc: DocumentBlocks, s: SessionSnapshot, width: number): string[] {
  const { client: c, theme: t } = doc.view;
  const lines: string[] = [];
  lines.push(
    ...doc.title('SESSION CONTEXT', width),
    ...doc.text('Session ' + s.id, width),
    ...doc.text('Worker epoch ' + s.epoch + ' · ' + s.state, width),
    ...doc.text('Provider ' + modelLabel(c), width),
    t.fill('', width),
  );
  if (s.inbox?.length) {
    lines.push(...doc.title('OPERATOR INBOX · ' + s.inbox.length, width));
    for (const item of s.inbox)
      lines.push(
        ...doc.text(item.kind + ' · ' + item.id + ' · revision ' + item.revision, width),
        ...doc.text(item.detail, width),
      );
    lines.push(
      ...doc.text(
        'Ctrl+K → Operator inbox to inspect or acknowledge. Acknowledgement never approves work.',
        width,
      ),
    );
  }
  if (c.workspace)
    lines.push(
      ...doc.title('OWNED WORKSPACE', width),
      ...doc.text(c.workspace.id, width),
      ...doc.text('Revision ' + c.workspace.revision + ' · ' + c.workspace.digest, width),
      ...doc.text('Current root: ' + c.workspace.root, width),
      t.fill('', width),
    );
  if (s.recurring_occurrence) {
    const r = s.recurring_occurrence;
    lines.push(
      ...doc.title('RECURRING OCCURRENCE', width),
      ...doc.text('Definition ' + r.job_id + ' · occurrence ' + r.id, width),
      ...doc.text('Key ' + r.occurrence_key + ' · schedule revision ' + r.schedule_revision, width),
    );
  }
  if (s.job) {
    const job = s.job;
    lines.push(
      ...doc.title('ONE-SHOT JOB · ' + job.state.toUpperCase(), width),
      ...doc.text(job.name + ' · ' + job.id, width),
      ...doc.text('Binding ' + job.binding_digest, width),
      ...doc.text(
        job.occurrence
          ? 'Occurrence ' + job.occurrence.id + ' · ' + job.occurrence.occurrence_key
          : 'No occurrence admitted',
        width,
      ),
      ...doc.text(job.reason, width),
    );
  }
  lines.push(...teamLines(doc, s, width));
  const task = s.work_task;
  if (task) lines.push(...taskLines(doc, task, width));
  lines.push(...doc.title('TASK FACTS', width));
  const facts = c.facts.filter((f) => !(f as { superseded_by?: string }).superseded_by);
  if (!facts.length) lines.push(...doc.text('No explicit task facts have been recorded.', width));
  for (const fact of facts)
    lines.push(
      ...doc.title(fact.kind.toUpperCase(), width, 'muted'),
      ...doc.prose(fact.id, fact.text, width - 4).map((line) => t.line(line, width)),
      t.fill('', width),
    );
  lines.push(...doc.title('CHILD WORK', width));
  for (const agent of s.agents ?? [])
    lines.push(
      ...doc.text(
        `${agent.profile_id} · revision ${agent.revision} · ${agent.state} · ${agent.route.provider}/${agent.route.model} · ${agent.tools.join(', ')}`,
        width,
      ),
    );
  if (!s.children.length) lines.push(...doc.text('No child work in this session.', width));
  for (const child of s.children)
    lines.push(
      ...doc.text(
        '└─ ' +
          shortId(child.id) +
          ' · ' +
          child.state +
          (child.result_id ? ' · result ' + shortId(child.result_id) : '') +
          (child.acknowledged ? ' · acknowledged' : ''),
        width,
      ),
      ...(child.worker
        ? doc.text(
            `${child.worker.binding.profile.id} · ${child.worker.binding.runtime} · generation ${child.worker.generation} · ${child.worker.dispatch_state} · ${child.worker.binding.bounds.scope === 'model-requests' ? child.worker.binding.bounds.requests + ' model requests' : child.worker.binding.bounds.invocations + ' invocation · internal model usage unknown'}`,
            width,
          )
        : []),
      ...(child.worker?.binding.isolation
        ? doc.text(
            `Private draft ${shortId(child.worker.binding.isolation.workspace_id)} · execution ${child.worker.binding.isolation.execution.evidence} · root integration requires a reviewed proposal digest`,
            width,
          )
        : []),
    );
  lines.push(t.fill('', width), ...doc.title('USAGE', width));
  if (c.usage)
    lines.push(
      ...doc.text(
        `${c.usage.observations} provider observations · ${c.usage.unknown_observations} unknown`,
        width,
      ),
      ...doc.text(
        `Recorded tokens: ${usageInput(c.usage)} input (${c.usage.known_cache_read ?? 0} cache reads, ${c.usage.known_cache_write ?? 0} cache writes) · ${c.usage.known_output} output`,
        width,
      ),
      ...doc.text(
        `Recorded cost $${c.usage.known_cost.toFixed(4)} · estimated $${c.usage.estimated_cost.toFixed(4)}`,
        width,
      ),
    );
  if (c.health?.execution?.backend)
    lines.push(
      t.fill('', width),
      ...doc.title('EXECUTION', width),
      ...doc.text(JSON.stringify(c.health.execution.backend, null, 2), width),
    );
  return lines;
}
/** The team board: assignments with their runtime and execution, then the passive messages. */
function teamLines(doc: DocumentBlocks, s: SessionSnapshot, width: number): string[] {
  const lines: string[] = [];
  const team = s.team as
    | {
        assignments: {
          id: string;
          profile_id: string;
          generation: number;
          step_state: string;
          stale: boolean;
          runtime?: { id: string; provider_route?: { provider: string; model: string } } | null;
          execution?: {
            state: string;
            stopped: boolean;
            stop_scope?: string;
            peer?: {
              peer_id: string;
              task_id: string | null;
              cancel_state: string | null;
              remote_state: string | null;
            } | null;
          } | null;
        }[];
        messages: {
          id: string;
          sender: string;
          recipient: string;
          delivered_at: number | null;
          acknowledged_at: number | null;
        }[];
      }
    | undefined;
  if (team?.assignments.length) {
    lines.push(...doc.title('TEAM BOARD', width));
    for (const a of team.assignments) {
      lines.push(
        ...doc.text(
          `${shortId(a.id)} · ${a.profile_id} · claim ${a.generation} · ${a.step_state}${a.stale ? ' · stale plan' : ''}`,
          width,
        ),
      );
      if (a.runtime)
        lines.push(...doc.text(a.runtime.id + ' · invocation budget · model usage unknown', width));
      if (a.execution?.peer)
        lines.push(
          ...doc.text(
            'Peer ' +
              a.execution.peer.peer_id +
              ' · task ' +
              (a.execution.peer.task_id ?? 'acceptance unknown'),
            width,
          ),
          ...doc.text(
            (a.execution.peer.remote_state ?? 'remote state unknown') +
              ' · ' +
              (a.execution.peer.cancel_state ?? 'no cancel requested'),
            width,
          ),
        );
      if (a.runtime?.provider_route)
        lines.push(
          ...doc.text(
            'Backend ' + a.runtime.provider_route.provider + '/' + a.runtime.provider_route.model,
            width,
          ),
        );
      if (a.execution)
        lines.push(
          ...doc.text(
            a.execution.state +
              ' · ' +
              (a.execution.stop_scope === 'never-dispatched'
                ? 'not dispatched'
                : a.execution.stop_scope === 'remote-terminal-receipt'
                  ? a.execution.stopped
                    ? 'remote terminal receipt'
                    : 'remote stop unconfirmed'
                  : a.execution.stopped
                    ? 'stop confirmed'
                    : 'stop unconfirmed'),
            width,
          ),
        );
    }
    lines.push(
      ...doc.text(
        'Messages are passive. Starting or continuing work requires a separate grant.',
        width,
      ),
    );
    for (const m of team.messages)
      lines.push(
        ...doc.text(
          `${shortId(m.id)} · ${m.sender === 'operator' ? 'operator' : shortId(m.sender)} → ${shortId(m.recipient)} · ${m.acknowledged_at ? 'acknowledged' : m.delivered_at ? 'delivered' : 'stored'}`,
          width,
        ),
      );
  }
  return lines;
}
/** The durable task: budgets, progression, verification, constraints and steps. */
function taskLines(
  doc: DocumentBlocks,
  task: NonNullable<SessionSnapshot['work_task']>,
  width: number,
): string[] {
  const t = doc.view.theme;
  const lines: string[] = [];
  lines.push(
    ...doc.title('DURABLE TASK · ' + task.state.toUpperCase(), width),
    ...doc.text(task.id + ' · revision ' + task.revision + ' · plan ' + task.plan_revision, width),
    ...doc.text(task.objective, width),
    ...doc.text(task.reason, width),
  );
  if (task.runtime)
    lines.push(
      ...doc.text(
        'Requests ' +
          task.runtime.requests_spent +
          ' spent + ' +
          task.runtime.reserved_requests +
          ' reserved / ' +
          task.limits.requests,
        width,
      ),
      ...doc.text(
        task.limits.token_units === null
          ? 'Token budget disabled · ' +
              (task.limits.output_token_bound === null
                ? 'no task output-token bound'
                : 'output bound ' + task.limits.output_token_bound)
          : 'Declared token units ' +
              task.runtime.token_units +
              ' + ' +
              task.runtime.reserved_tokens +
              ' reserved / ' +
              task.limits.token_units,
        width,
      ),
      ...doc.text(
        'Bounded progression ' +
          (task.runtime.auto_enabled
            ? 'enabled · ' + task.runtime.remaining_steps + ' new steps remain'
            : 'paused') +
          (task.runtime.auto_error ? ' · ' + task.runtime.auto_error : ''),
        width,
      ),
    );
  if (task.verification) {
    const verification = task.verification as {
      checks?: {
        id: string;
        check_key: string;
        state: string;
        fresh: boolean;
        workspace_revision: number;
      }[];
      completion?: { state: string; fresh: boolean } | null;
    };
    lines.push(...doc.title('VERIFICATION', width));
    for (const check of verification.checks ?? [])
      lines.push(
        ...doc.text(
          `${check.check_key} · ${check.state} · ${check.fresh ? 'current' : 'historical'} · r${check.workspace_revision} · ${shortId(check.id)}`,
          width,
        ),
      );
    if (verification.completion)
      lines.push(
        ...doc.text(
          `Task ${verification.completion.state} · ${verification.completion.fresh ? 'current verification' : 'verification needs refresh'}`,
          width,
        ),
      );
    lines.push(...doc.text('Ctrl+K → Inspect task for complete check receipts.', width));
  }
  for (const constraint of task.constraints)
    lines.push(...doc.text('Constraint: ' + constraint, width));
  for (const step of task.steps)
    lines.push(
      ...doc.title(step.key + ' · ' + step.state, width, 'muted'),
      ...doc.text(step.title, width),
      ...doc.text(step.instruction, width),
      ...doc.text(
        'Step ' + step.id + (step.attempt_id ? ' · attempt ' + step.attempt_id : ''),
        width,
      ),
      ...doc.text('Depends on: ' + (step.depends_on.join(', ') || 'none'), width),
      ...(step.review ? doc.text('Operator review: ' + step.review, width) : []),
    );
  lines.push(
    ...doc.text('Ctrl+K → Task actions · receipts bind the exact workspace revision.', width),
    t.fill('', width),
  );
  return lines;
}
