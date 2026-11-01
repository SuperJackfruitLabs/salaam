import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { ROOT } from '../src/config.js';
import { until } from './helpers.js';
export function client(state: string, env: Record<string, string> = {}, args: string[] = []) {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'bin/salaam.mjs'), 'acp', '--state', state, ...args],
    {
      env: { ...process.env, ...env },
    },
  );
  let next = 0,
    buffer = '',
    stderr = '';
  const messages: Record<string, any>[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      messages.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  const request = async (method: string, params: unknown = {}) => {
    const id = ++next;
    send({ jsonrpc: '2.0', id, method, params });
    const response = await until(
      () => messages.find((m) => m.id === id && !m.method),
      Boolean,
      15000,
    );
    if (response!.error)
      throw Object.assign(new Error(response!.error.message), {
        code: response!.error.code,
        data: response!.error.data,
      });
    return response!.result;
  };
  return {
    child,
    messages,
    send,
    request,
    stderr: () => stderr,
    initialize: (capabilities: Record<string, unknown> = {}) =>
      request('initialize', { protocolVersion: 1, clientCapabilities: capabilities }),
    permission: (id: string, approve: boolean) =>
      send({
        jsonrpc: '2.0',
        id,
        result: {
          outcome: { outcome: 'selected', optionId: approve ? 'allow-once' : 'reject-once' },
        },
      }),
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        await exit;
        clearTimeout(timer);
      }
    },
  };
}
