import { call } from '../../core/index.js';
import { describeHooks } from '../../local/index.js';
import { classifierItems, classifierNotice, type ClassifierView } from '../classifier.js';
import { jobsText, type JobRow } from '../notify.js';
import type { SlashCommand } from './types.js';

// What the session can use and has used: tools, agents, MCP, usage, context and skills, hooks,
// the command reviewer and background commands.

const json = (value: unknown) => JSON.stringify(value, null, 2);

const tools: SlashCommand = {
  names: ['tools'],
  session: true,
  run(ctx, _args, _name, snapshot) {
    ctx.showText(
      'Tools and activity',
      json({
        capabilities: snapshot.capabilities,
        controller: snapshot.control,
        pending_approvals: snapshot.approvals.filter((a) => a.state === 'pending'),
        activity: ctx.client.activity,
      }),
    );
  },
};

const agents: SlashCommand = {
  names: ['agents'],
  session: true,
  run(ctx, _args, _name, snapshot) {
    ctx.showText(
      'Agents',
      json({
        profiles: snapshot.agents ?? [],
        children: snapshot.children,
        team: snapshot.team ?? null,
      }),
    );
  },
};

const mcp: SlashCommand = {
  names: ['mcp'],
  session: true,
  run(ctx, _args, _name, snapshot) {
    ctx.showText(
      'Managed MCP',
      json({
        capabilities: snapshot.capabilities.filter((c) => /mcp|toolkit/.test(c)),
        operations: snapshot.operations.filter((o) => o.kind === 'mcp'),
      }),
    );
  },
};

const usage: SlashCommand = {
  names: ['usage'],
  session: true,
  run(ctx) {
    ctx.showText(
      'Provider usage',
      json(ctx.client.usage ?? { status: 'No usage observations yet; this is not zero usage.' }),
    );
  },
};

const skills: SlashCommand = {
  names: ['skills'],
  session: true,
  async run(ctx, args, _name, snapshot) {
    if (args === 'clear' || args.startsWith('review ')) {
      const paths =
        args === 'clear' ? [] : args.slice('review '.length).trim().split(/\s+/).filter(Boolean);
      if (args !== 'clear' && !paths.length)
        throw Error('Use /skills review AGENTS.md .salaam/skills/sjl-profile');
      const plan = await ctx.client.planContext({
        files: paths.filter((path) => path.endsWith('.md')),
        bundles: paths.filter((path) => !path.endsWith('.md')),
      });
      ctx.confirm(
        'Review context and skills',
        'These exact bytes become model context. No tools or permissions are granted. Editing any reviewed resource blocks future grants until renewed.\n\n' +
          json(plan),
        args === 'clear' ? 'Clear admission' : 'Admit reviewed context',
        () => ctx.client.admitContext(plan),
      );
      return;
    }
    if (args) throw Error('Use /skills, /skills review <relative paths>, or /skills clear');
    ctx.showText(
      'Skills',
      json(await call(ctx.client.socket, `/v1/sessions/${snapshot.id}/context`)),
    );
  },
};

const hooks: SlashCommand = {
  names: ['hooks'],
  session: false,
  async run(ctx, args) {
    if (args === 'revoke') {
      await ctx.client.revokeHooks();
      return;
    }
    const { sources } = await ctx.client.hooks();
    if (args === 'trust') {
      const repo = sources.find((s) => s.scope === 'repo');
      if (!repo?.digest) throw new Error('This workspace has no readable .salaam/hooks.json.');
      if (repo.trusted) {
        ctx.showText('Hooks', 'This workspace’s hooks are already trusted as they are.');
        return;
      }
      ctx.confirm(
        'Trust this workspace’s hooks?',
        describeHooks([repo]) +
          '\n\nThese commands will run on your machine, in this session’s sandbox, whenever their event happens. Trust covers this exact content; any change needs trusting again.',
        'Trust these hooks',
        () => ctx.client.trustHooks(repo.digest!),
      );
      return;
    }
    if (args) throw new Error('Use /hooks, /hooks trust or /hooks revoke.');
    ctx.showText('Hooks', describeHooks(sources));
  },
};

const classifier: SlashCommand = {
  names: ['classifier'],
  session: true,
  async run(ctx, args, _name, snapshot) {
    const path = `/v1/sessions/${snapshot.id}/danger-classifier`;
    const set = async (choice: string) => {
      const v = await call<ClassifierView>(ctx.client.socket, path, {
        ...ctx.client.actor(),
        choice,
      });
      ctx.client.notice = classifierNotice(v);
      ctx.tui.requestRender();
    };
    const want = args.trim();
    if (want === 'on') {
      const v = await call<ClassifierView>(ctx.client.socket, path, {
        ...ctx.client.actor(),
        enabled: true,
      });
      ctx.client.notice = classifierNotice(v);
      return;
    }
    if (want) {
      await set(want);
      return;
    }
    const v = await call<ClassifierView>(ctx.client.socket, path);
    const items = classifierItems(v);
    if (!items.length) {
      ctx.client.notice = classifierNotice(v);
      return;
    }
    ctx.choice('Command reviewer · ' + classifierNotice(v).split('.')[0], items, (choice) => {
      void ctx.execute(() => set(choice));
    });
  },
};

const jobs: SlashCommand = {
  names: ['jobs'],
  session: true,
  async run(ctx, args, _name, snapshot) {
    const base = `/v1/sessions/${snapshot.id}/local-tasks`;
    const stop = /^stop\s+(\S+)$/.exec(args.trim());
    if (stop) {
      await call(ctx.client.socket, `${base}/${stop[1]}/stop`, {});
      ctx.client.notice = 'Stopping background command ' + stop[1];
      return;
    }
    const { tasks } = await call<{ tasks: JobRow[] }>(ctx.client.socket, base);
    const outputs = await Promise.all(
      tasks.slice(0, 4).map((t) => call<{ output: string }>(ctx.client.socket, `${base}/${t.id}`)),
    );
    ctx.showText('Background commands', jobsText(tasks, outputs));
  },
};

export const INSPECT_COMMANDS: readonly SlashCommand[] = [
  tools,
  agents,
  mcp,
  usage,
  skills,
  hooks,
  classifier,
  jobs,
];
