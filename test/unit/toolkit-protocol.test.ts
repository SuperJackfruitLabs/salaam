import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { toolkitRequest } from '../../src/toolkit-protocol.js';
import { digest } from '../../src/protocol.js';

// Read with the actual JavaScript decoder: the corpus includes an invalid lone
// surrogate that the build tool's JSON loader rejects before the consumer runs.
const corpus = JSON.parse(
  readFileSync(new URL('../fixtures/toolkit-managed-mcp-v1.json', import.meta.url), 'utf8'),
) as {
  requests: {
    name: string;
    accept: boolean;
    value: unknown;
    request_digest?: string;
    id?: string;
  }[];
};

for (const sample of corpus.requests)
  test(`Toolkit owner corpus: ${sample.name}`, () => {
    if (!sample.accept) {
      expect(() => toolkitRequest(sample.value)).toThrow();
      return;
    }
    const request = toolkitRequest(sample.value);
    expect(request).toEqual(sample.value);
    expect(digest(request)).toBe(sample.request_digest);
    expect(digest(['stk.managed-mcp.v1', request.root_digest, request.invocation_id])).toBe(
      sample.id,
    );
  });
