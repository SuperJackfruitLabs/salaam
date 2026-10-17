import house from '../../dist/src/house-extension.js';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A real Pi tool turn held after its durable service grant, while heartbeats run.
export default function blocked(pi) {
  const register = pi.registerTool.bind(pi);
  pi.registerTool = (tool) =>
    register({
      ...tool,
      async execute(...args) {
        const result = await tool.execute(...args);
        writeFileSync(join(process.cwd(), 'probe-entered'), args[0]);
        while (!existsSync(join(process.cwd(), 'release-probe'))) {
          if (args[2]?.aborted) throw new Error('Aborted by test shutdown');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return result;
      },
    });
  house(pi);
}
