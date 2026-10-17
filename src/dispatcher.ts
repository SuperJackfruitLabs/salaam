import type { Store } from './store.js';
import type { Supervisor } from './supervisor.js';
import type { DurableEvent } from './protocol.js';

/** The queue belongs to the service, never to a terminal or Pi's volatile queue. */
export class Dispatcher {
  private paused = false;
  private active = new Map<string, Promise<void>>();
  private change = (event: DurableEvent) => {
    if (event.kind === 'submission.accepted' || event.kind === 'worker.ready')
      this.kick(event.session_id);
  };
  private idle = (id: string) => this.kick(id);
  constructor(
    private store: Store,
    private supervisor: Supervisor,
  ) {
    store.changes.on('event', this.change);
    supervisor.on('idle', this.idle);
  }
  kick(id: string): void {
    setImmediate(() => {
      if (this.paused || this.active.has(id)) return;
      const run = (async () => {
        while (!this.paused && (await this.supervisor.dispatchNext(id))) {}
      })()
        .catch((error) => {
          // Persistence failure leaves the durable dispatch boundary intact.
          // Recovery will interrupt it; never retry it from an in-memory catch.
          console.error('Prompt dispatch stopped:', (error as Error).message);
        })
        .finally(() => this.active.delete(id));
      this.active.set(id, run);
    });
  }
  pause(): void {
    this.paused = true;
    this.store.changes.off('event', this.change);
    this.supervisor.off('idle', this.idle);
  }
  async drain(): Promise<void> {
    await Promise.all(this.active.values());
  }
}
