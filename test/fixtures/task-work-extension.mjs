import blocked from './blocked-extension.mjs';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function fixture(pi) {
  blocked(pi);
  pi.on('before_provider_request', (event) => {
    appendFileSync(
      join(process.cwd(), 'work-payloads.jsonl'),
      JSON.stringify(event.payload) + '\n',
    );
  });
}
