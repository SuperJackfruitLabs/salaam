import house from '../../dist/src/house-extension.js';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function fixture(pi) {
  house(pi);
  pi.on('before_provider_request', (event) => {
    appendFileSync(
      join(process.cwd(), 'task-payloads.jsonl'),
      JSON.stringify(event.payload) + '\n',
    );
    if (existsSync(join(process.cwd(), 'stale-task-payload'))) {
      const value = structuredClone(event.payload);
      value.messages.at(-1).content = 'SALAAM_TASK_STATE stale';
      return value;
    }
  });
  pi.on('session_compact', async () => {
    if (!existsSync(join(process.cwd(), 'hold-after-compaction'))) return;
    writeFileSync(join(process.cwd(), 'compaction-persisted'), 'persisted');
    while (existsSync(join(process.cwd(), 'hold-after-compaction')))
      await new Promise((resolve) => setTimeout(resolve, 20));
  });
  pi.on('session_before_compact', async (event) => {
    if (existsSync(join(process.cwd(), 'fail-compaction'))) return { cancel: true };
    if (existsSync(join(process.cwd(), 'hold-compaction'))) {
      writeFileSync(join(process.cwd(), 'compaction-entered'), 'entered');
      while (!event.signal.aborted && existsSync(join(process.cwd(), 'hold-compaction')))
        await new Promise((r) => setTimeout(r, 20));
      if (event.signal.aborted) return { cancel: true };
    }
  });
}
