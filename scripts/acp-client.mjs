import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
export class DemoAcpClient extends EventEmitter {
  constructor(command, args) {
    super();
    this.messages = [];
    this.next = 0;
    this.pending = new Map();
    this.buffer = '';
    this.child = spawn(command, args);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 1);
        this.messages.push(message);
        if (!message.method && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        } else this.emit('message', message);
      }
    });
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('ACP exited'));
      }
      this.pending.clear();
    });
  }
  send(value) {
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('ACP request timed out: ' + method));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exit = once(this.child, 'exit');
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await exit;
    clearTimeout(timer);
  }
}
