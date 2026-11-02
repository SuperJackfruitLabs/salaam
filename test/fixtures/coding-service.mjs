import { SalaamService } from '../../dist/src/service/service.js';
const [stateDir, codingRoot, codingSocket] = process.argv.slice(2);
const service = await SalaamService.open({ stateDir, codingRoot, codingSocket });
console.log(JSON.stringify({ socket: service.socket }));
await service.closed;
