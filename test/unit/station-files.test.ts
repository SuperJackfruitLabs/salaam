import { test, expect } from 'vitest';
import { stationFileResult } from '../../src/agentpod/station-files.js';
import corpus from '../fixtures/agentpod-station-files-v1.json' with { type: 'json' };

for (const c of corpus.receipts)
  test('private station receipt: ' + c.name, () => {
    if (c.accept) expect(stationFileResult(c.request, c.receipt)).toEqual(c.receipt);
    else expect(() => stationFileResult(c.request, c.receipt)).toThrow();
  });
