import house from '../../dist/src/runtime/house-extension.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default function writingFixture(pi) {
  const config = JSON.parse(process.env.SALAAM_WORKER_CONFIG),
    register = pi.registerTool.bind(pi);
  pi.registerTool = (tool) =>
    register({
      ...tool,
      async execute(id, args, signal, update, ctx) {
        const result = await tool.execute(id, args, signal, update, ctx);
        const binding = config.worker_binding?.binding;
        if (tool.name !== 'salaam_probe' || !binding) return result;
        const invoke = async (name, args, expectedError = false) => {
          const response = await ctx.executeTool(name, args, { signal });
          if (!!response.isError !== expectedError)
            throw new Error('Unexpected fixture tool outcome: ' + JSON.stringify(response));
          return response.result.details;
        };
        if (binding.profile.role === 'reviewer') {
          const file = await invoke('salaam_repository', { action: 'read', path: 'app.js' });
          const diff = await invoke('salaam_repository', { action: 'diff' });
          const findings = await invoke('salaam_findings', { findings: [] });
          writeFileSync(
            join(process.cwd(), 'review-evidence-' + config.session),
            JSON.stringify({ file, diff, findings }),
          );
          return result;
        }
        if (!binding.isolation) return result;
        let workspace = binding.tools.includes('salaam_files')
          ? await invoke('salaam_files', { action: 'inspect' })
          : { revision: 0 };
        const evidence = {
          before: workspace,
          denied: [],
          tools: binding.tools,
          execution: binding.isolation.execution,
        };
        if (binding.profile.id.endsWith('/escape')) {
          for (const path of ['../outside', '/etc/passwd', '.env', '.salaam/config'])
            evidence.denied.push(await invoke('salaam_files', { action: 'read', path }, true));
          writeFileSync(
            join(process.cwd(), 'writing-evidence-' + config.session),
            JSON.stringify(evidence),
          );
          return result;
        }
        if (binding.tools.includes('salaam_files')) {
          const target = binding.profile.id.endsWith('builder-b') ? 'notes.md' : 'app.js';
          const file = await invoke('salaam_files', { action: 'read', path: target });
          evidence.patch = await invoke('salaam_files', {
            action: 'patch',
            path: target,
            expected_revision: workspace.revision,
            expected_hash: file.hash,
            content:
              target === 'app.js'
                ? 'export const answer = 42;\n'
                : '# The answer\n\nThe API returns 42.\n',
          });
          workspace = await invoke('salaam_files', { action: 'inspect' });
        }
        if (binding.tools.includes('salaam_command'))
          evidence.command = await invoke('salaam_command', {
            action: 'start',
            step_key: 'check-owned-draft',
            command: binding.profile.id.endsWith('builder-b')
              ? 'node --test notes.test.js'
              : 'node --test app.test.js',
            expected_revision: workspace.revision,
          });
        writeFileSync(
          join(process.cwd(), 'writing-evidence-' + config.session),
          JSON.stringify(evidence),
        );
        return result;
      },
    });
  house(pi);
}
