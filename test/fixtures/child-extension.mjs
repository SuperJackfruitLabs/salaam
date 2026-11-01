import house from '../../dist/src/runtime/house-extension.js';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function childFixture(pi) {
  const config = JSON.parse(process.env.SALAAM_WORKER_CONFIG);
  const register = pi.registerTool.bind(pi);
  pi.registerTool = (tool) =>
    register({
      ...tool,
      async execute(...args) {
        const result = await tool.execute(...args);
        const consume = tool.name === 'consume_child_result' && !args[1].acknowledge;
        if (config.child || consume) {
          const key = consume ? `delivered-${args[1].result_id}` : `child-${config.session}`;
          writeFileSync(join(process.cwd(), key), 'entered');
          while (!existsSync(join(process.cwd(), 'release-' + key))) {
            if (args[2]?.aborted) throw new Error('Cancelled by test');
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        return result;
      },
    });
  house(pi);
}
