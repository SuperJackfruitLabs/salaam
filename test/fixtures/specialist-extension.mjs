import house from '../../dist/src/runtime/house-extension.js';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function installSpecialistFixture(pi) {
  const config = JSON.parse(process.env.SALAAM_WORKER_CONFIG);
  const register = pi.registerTool.bind(pi);
  pi.registerTool = (tool) =>
    register({
      ...tool,
      async execute(id, args, signal, update, ctx) {
        if (tool.name === 'spawn_child' && args.tasks) {
          const children = [];
          for (const task of args.tasks) {
            const profile = task.step_key.startsWith('project-')
              ? 'project/' + task.step_key.slice(8)
              : 'salaam/' + task.step_key;
            children.push(
              await tool.execute(
                id,
                { ...task, profile, budget: 2, wait: false },
                signal,
                update,
                ctx,
              ),
            );
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(children) }],
            details: { children },
          };
        }
        const result = await tool.execute(id, args, signal, update, ctx);
        if (tool.name === 'salaam_probe' && config.worker_binding?.binding.repository) {
          // Crash proofs need an entered, held tool turn, not completed repository evidence.
          // Keep this barrier separate so evidence-producing fixtures retain their semantics.
          if (existsSync(join(process.cwd(), 'hold-specialist-turn'))) {
            writeFileSync(join(process.cwd(), 'specialist-turn-entered-' + config.session), 'held');
            while (!existsSync(join(process.cwd(), 'release-specialist-turn'))) {
              if (signal?.aborted) throw new Error('Cancelled');
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          const outcomes = [];
          for (const action of [
            { action: 'list' },
            { action: 'search', query: 'answer' },
            { action: 'read', path: 'app.js' },
          ]) {
            const outcome = await ctx.executeTool('salaam_repository', action, { signal });
            if (outcome.isError) throw new Error('Snapshot evidence failed');
            outcomes.push(outcome.result);
          }
          if (config.worker_binding.binding.profile.role === 'reviewer') {
            outcomes.push(
              (await ctx.executeTool('salaam_repository', { action: 'diff' }, { signal })).result,
            );
            const report = await ctx.executeTool(
              'salaam_findings',
              {
                findings: [
                  {
                    path: 'app.js',
                    line: 1,
                    severity: 'high',
                    message: 'Seeded fixture defect: answer differs from the required 42.',
                  },
                ],
              },
              { signal },
            );
            if (report.isError) throw new Error('Findings report failed');
            outcomes.push(report.result);
          }
          writeFileSync(
            join(process.cwd(), 'evidence-' + config.session),
            JSON.stringify(outcomes),
          );
          if (existsSync(join(process.cwd(), 'hold-specialists'))) {
            while (!existsSync(join(process.cwd(), 'release-specialists'))) {
              if (signal?.aborted) throw new Error('Cancelled');
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
        }
        return result;
      },
    });
}
export default function specialistFixture(pi) {
  installSpecialistFixture(pi);
  house(pi);
}
