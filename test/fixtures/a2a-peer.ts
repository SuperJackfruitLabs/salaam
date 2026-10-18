import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentCard, Task } from '@a2a-js/sdk';
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  type A2ARequestHandler,
} from '@a2a-js/sdk/server';
import { digest } from '../../src/protocol.js';
import type { A2APeer } from '../../src/a2a-peer.js';

/** Actual pinned official SDK wire serialization; no live model or peer-product claim. */
export async function sdkPeer() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sal-a2a-peer-'))),
    token = 'fixture-peer-token-' + 'x'.repeat(40);
  const tasks = new Map<string, any>(),
    messages = new Map<string, string>(),
    requests: any[] = [];
  let accepted = 0,
    card: any,
    lost = false,
    complete = true;
  const handler = {
    async getAgentCard() {
      return AgentCard.fromJSON(card);
    },
    async sendMessage(params: any) {
      const id = params.message.messageId;
      if (messages.has(id)) return Task.fromJSON(tasks.get(messages.get(id)!));
      const taskId = 'sdk-task-' + ++accepted;
      messages.set(id, taskId);
      const task = {
        id: taskId,
        contextId: 'sdk-context-' + accepted,
        status: { state: complete ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING' },
        artifacts: complete
          ? [{ artifactId: 'review', parts: [{ data: { findings: [], verified_success: false } }] }]
          : [],
      };
      tasks.set(taskId, task);
      return Task.fromJSON(task);
    },
    async getTask(params: any) {
      if (!tasks.has(params.id)) throw Error('Task expired');
      return Task.fromJSON(tasks.get(params.id));
    },
    async cancelTask(params: any) {
      const task = tasks.get(params.id);
      task.status.state = 'TASK_STATE_CANCELED';
      return Task.fromJSON(task);
    },
  } as unknown as A2ARequestHandler;
  const transport = new JsonRpcTransportHandler(handler);
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}` || req.headers['a2a-version'] !== '1.0') {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url === '/.well-known/agent-card.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(card));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      if (body.params.tenant !== 'tenant-a') throw Error('Wrong fixture tenant');
      const response = await transport.handle(
        body,
        new ServerCallContext({ requestedVersion: '1.0', tenant: 'tenant-a' }),
      );
      if (lost && body.method === 'SendMessage') {
        res.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'A2A-Version': '1.0' });
      res.end(JSON.stringify(response));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port,
    endpoint = `http://127.0.0.1:${port}/a2a`;
  card = AgentCard.toJSON(
    AgentCard.fromJSON({
      name: 'Independent SDK fixture',
      description: 'Offline protocol fixture',
      version: '1',
      supportedInterfaces: [
        { url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: 'tenant-a' },
      ],
      capabilities: {},
      skills: [{ id: 'review', name: 'Review', description: 'Analysis', tags: ['review'] }],
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['application/json'],
    }),
  );
  const credential = { peer: 'sdk', token },
    credential_file = join(dir, 'credential.json');
  writeFileSync(credential_file, JSON.stringify(credential), { mode: 0o600 });
  const peer: A2APeer = {
    id: 'sdk',
    endpoint,
    card_url: `http://127.0.0.1:${port}/.well-known/agent-card.json`,
    card_digest: digest(card),
    tenant: 'tenant-a',
    skill: 'review',
    addresses: ['127.0.0.1'],
    local: true,
    credential_file,
    credential_digest: digest(credential),
    files: ['app.js'],
    retention: 'volatile',
    cancel: true,
    streaming: false,
  };
  return {
    dir,
    token,
    peer,
    requests,
    tasks,
    get card() {
      return card;
    },
    get accepted() {
      return accepted;
    },
    set lost(v: boolean) {
      lost = v;
    },
    set complete(v: boolean) {
      complete = v;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
