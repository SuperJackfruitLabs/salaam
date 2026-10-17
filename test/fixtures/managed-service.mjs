import { SalaamService } from '../../dist/src/service.js';
import { SocketEffectConnector } from '../../dist/src/effect-connector.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = process.argv[2];
const service = await SalaamService.open({
  stateDir: state,
  effectConnector: new SocketEffectConnector(process.argv[3], {
    opaque: process.argv.includes('--opaque'),
    timeoutMs: 30000,
  }),
});
if (process.argv.includes('--before-receipt')) {
  const record = service.managed.recordReceipt.bind(service.managed);
  service.managed.recordReceipt = (...args) => {
    writeFileSync(join(state, 'receipt-pending'), args[0]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return record(...args);
  };
}
process.stdout.write('started\n');
process.once('SIGTERM', () => void service.close());
await service.closed;
