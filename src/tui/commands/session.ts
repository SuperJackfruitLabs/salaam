import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { slashHelp } from '../../core/index.js';
import { conversationExport, writeConversationExport } from '../export.js';
import { history } from '../panels/history.js';
import type { SlashCommand } from './types.js';

// The session itself: leave, help, open or create one, settings and status, and what can be done
// with its conversation.

const exit: SlashCommand = {
  names: ['exit'],
  session: false,
  run(ctx) {
    ctx.finish();
  },
};

const help: SlashCommand = {
  names: ['help'],
  session: false,
  run(ctx, args) {
    const custom = args ? [] : ctx.customCommands();
    const problems = args ? [] : ctx.customCommandProblems;
    ctx.showText(
      'Salaam commands',
      slashHelp(args || undefined) +
        (custom.length
          ? '\n\nCustom commands (write a prompt only):\n' +
            custom
              .map(
                (c) =>
                  `/${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''} — ${c.description} [${c.scope}]`,
              )
              .join('\n')
          : '') +
        (problems.length ? '\n\nSkipped command files:\n' + problems.join('\n') : ''),
    );
  },
};

const keys: SlashCommand = {
  names: ['keys'],
  session: false,
  run(ctx) {
    ctx.help();
  },
};

const create: SlashCommand = {
  names: ['new', 'coding'],
  session: false,
  async run(ctx, args, command) {
    if (args) {
      await ctx.startService();
      await ctx.client.create(resolve(args), false, ctx.selectedRoute, command === 'coding');
      ctx.setTab('conversation');
    } else await ctx.newSession(command === 'coding');
  },
};

const sessions: SlashCommand = {
  names: ['sessions'],
  session: false,
  async run(ctx, args) {
    if (args) {
      await ctx.client.open(args, {
        observe: ctx.options.observe,
        takeover: ctx.options.takeover,
      });
      ctx.setTab('conversation');
    } else await ctx.sessions();
  },
};

const settings: SlashCommand = {
  names: ['settings'],
  session: false,
  run(ctx) {
    ctx.choice(
      'Settings',
      [
        { value: 'permissions', label: 'Permissions · inspect, review or scoped edits' },
        { value: 'progression', label: 'Progression · manual, bounded tasks or schedules' },
        { value: 'model', label: 'Provider and model' },
        { value: 'theme', label: 'Switch Night / Paper' },
        { value: 'rail', label: 'Toggle workspace rail' },
        { value: 'keys', label: 'Keyboard shortcuts' },
      ],
      (value) => {
        if (value === 'theme') ctx.toggleTheme();
        else if (value === 'rail') ctx.toggleRail();
        else void ctx.execute(() => ctx.runSlashCommand(value));
      },
    );
  },
};

const status: SlashCommand = {
  names: ['status'],
  session: false,
  run(ctx) {
    const snapshot = ctx.client.snapshot;
    ctx.showText(
      'Session status',
      JSON.stringify(
        {
          connection: ctx.client.connection,
          session: snapshot?.id,
          workspace: snapshot?.cwd,
          route: snapshot?.provider_route ?? ctx.client.health?.provider_route,
          capabilities: snapshot?.capabilities,
          pending_delivery: ctx.client.pendingInputs,
        },
        null,
        2,
      ),
    );
  },
};

const name: SlashCommand = {
  names: ['name'],
  session: true,
  async run(ctx, args) {
    if (!args || args.length > 120 || /[\x00-\x1f\x7f]/.test(args))
      throw new Error('Use /name followed by 1–120 printable characters.');
    await ctx.client.name(args);
    ctx.client.report('Session named ' + args);
  },
};

const browse: SlashCommand = {
  names: ['history'],
  session: true,
  async run(ctx) {
    await history(ctx);
  },
};

const compact: SlashCommand = {
  names: ['compact'],
  session: true,
  async run(ctx) {
    await ctx.client.compact();
  },
};

const context: SlashCommand = {
  names: ['context'],
  session: true,
  run(ctx) {
    ctx.setTab('context');
  },
};

const fork: SlashCommand = {
  names: ['fork'],
  session: true,
  run(ctx) {
    ctx.confirm(
      'Fork session',
      'Create an independent conversation from the captured history? Both sessions share the same workspace; files are not cloned. Pending approvals and task authority are not copied.',
      'Fork conversation',
      () => ctx.client.fork(),
    );
  },
};

const exportHistory: SlashCommand = {
  names: ['export'],
  session: true,
  async run(ctx, args, _name, snapshot) {
    const path = resolve(args || `salaam-${snapshot.id}.md`);
    const text = await conversationExport(ctx.client.socket, snapshot.id);
    writeConversationExport(path, text);
    ctx.client.report('Exported full captured history to ' + path);
  },
};

const copy: SlashCommand = {
  names: ['copy'],
  session: true,
  async run(ctx, _args, _name, snapshot) {
    const last = [...snapshot.messages].toReversed().find((m) => m.role === 'assistant');
    if (!last) throw new Error('No assistant response to copy.');
    if (last.truncated)
      throw new Error('Response preview is truncated. Use /export for complete captured history.');
    if (process.platform !== 'darwin')
      throw new Error(
        'Clipboard copying is currently supported on macOS; use /export on this platform.',
      );
    await new Promise<void>((done, reject) => {
      const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'pipe'] });
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? done() : reject(new Error('Clipboard copy failed.')),
      );
      child.stdin.end(last.text);
    });
    ctx.client.report('Copied the last assistant response.');
  },
};

export const SESSION_COMMANDS: readonly SlashCommand[] = [
  exit,
  help,
  keys,
  create,
  sessions,
  settings,
  status,
  name,
  browse,
  compact,
  context,
  fork,
  exportHistory,
  copy,
];
