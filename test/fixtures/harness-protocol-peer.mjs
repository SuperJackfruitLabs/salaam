import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync } from 'node:fs';
const [mode, dialect, database, audit] = process.argv.slice(2),
  session = 'owned-session',
  thread = 'owned-thread',
  turn = 'owned-turn';
const db = new DatabaseSync(database, { readOnly: true });
const send = (value) =>
  process.stdout.write(
    JSON.stringify({ ...(dialect === 'acp' ? { jsonrpc: '2.0' } : {}), ...value }) + '\n',
  );
const terminal = (status) =>
  send({
    method: 'turn/completed',
    params: { threadId: thread, turn: { id: mode === 'foreign' ? 'wrong-turn' : turn, status } },
  });
let prompt;
const finishAcpPrompt = (stopReason) => {
  if (prompt === undefined) return;
  send({ id: prompt, result: { stopReason } });
  prompt = undefined;
};
const permission = () =>
  send({
    id: 'permission',
    method: dialect === 'acp' ? 'session/request_permission' : 'item/fileChange/requestApproval',
    params:
      dialect === 'acp'
        ? {
            sessionId: mode === 'foreign-permission' ? 'other-session' : session,
            toolCall: { toolCallId: 'owned-tool', rawInput: { path: '/workspace/app.js' } },
            options: [
              { kind: 'allow_once', optionId: 'one' },
              { kind: 'reject_once', optionId: 'no' },
            ],
          }
        : {
            threadId: thread,
            turnId: mode === 'foreign-permission' ? 'other-turn' : turn,
            itemId: 'owned-item',
            reason: 'fixture scoped edit',
          },
  });
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!m.method) {
    appendFileSync(audit, JSON.stringify({ permission_reply: m }) + '\n');
    if (dialect === 'acp') finishAcpPrompt(m.error ? 'refusal' : 'end_turn');
    else terminal(m.error ? 'failed' : 'completed');
    continue;
  }
  const checkpoint = JSON.parse(
    db.prepare('SELECT document FROM checkpoint WHERE id=1').get().document,
  );
  appendFileSync(audit, JSON.stringify({ method: m.method, checkpoint }) + '\n');
  if (m.method === 'initialize') {
    send({
      id: m.id,
      result:
        dialect === 'acp'
          ? { protocolVersion: 1, agentCapabilities: { loadSession: mode !== 'no-load' } }
          : { userAgent: 'fixture' },
    });
    continue;
  }
  if (m.method === 'initialized') continue;
  if (m.method === 'session/new') {
    send({ id: m.id, result: { sessionId: session } });
    continue;
  }
  if (m.method === 'thread/start') {
    send({ id: m.id, result: { thread: { id: thread } } });
    continue;
  }
  if (m.method === 'session/load') {
    send({ id: m.id, result: {} });
    continue;
  }
  if (m.method === 'thread/read') {
    send({
      id: m.id,
      result: {
        thread: {
          id: mode === 'wrong-read' ? 'foreign' : thread,
          turns: [{ id: turn, status: 'completed' }],
        },
      },
    });
    continue;
  }
  if (m.method === 'session/cancel') {
    finishAcpPrompt('cancelled');
    continue;
  }
  if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    setTimeout(() => terminal('interrupted'), 50);
    continue;
  }
  if (m.method === 'session/prompt' || m.method === 'turn/start') {
    prompt = m.id;
    if (mode === 'crash') process.exit(4);
    if (dialect === 'acp') {
      if (mode === 'wait') continue;
      if (mode.includes('permission')) {
        permission();
        continue;
      }
      send({
        method: 'session/update',
        params: {
          sessionId: mode === 'foreign' ? 'foreign' : session,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'observed' },
          },
        },
      });
      finishAcpPrompt('end_turn');
    } else {
      if (mode === 'early') terminal('completed');
      send({ id: m.id, result: { turn: { id: turn, status: 'inProgress' } } });
      if (mode === 'wait') continue;
      if (mode.includes('permission')) {
        setTimeout(permission, 5);
        continue;
      }
      if (mode !== 'early')
        setTimeout(() => {
          terminal('completed');
          if (mode === 'duplicate') terminal('completed');
        }, 5);
    }
  }
}
