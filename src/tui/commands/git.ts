import { INIT_INSTRUCTION } from '../../core/index.js';
import {
  branchInstruction,
  commitInstruction,
  currentBranch,
  defaultBase,
  forgeTool,
  loadGitPrefs,
  prInstruction,
  validBranchName,
} from '../../local/index.js';
import type { SlashCommand } from './types.js';

// Phase 4a: /commit, /branch and /pr become instructions to the model; git runs only through the
// session's own command approvals. /init asks it to draft AGENTS.md the same way.

const git: SlashCommand = {
  names: ['commit', 'branch', 'pr'],
  session: true,
  async run(ctx, args, command, snapshot) {
    if (!snapshot.capabilities.includes('local-coding-reviewed'))
      throw new Error(`/${command} runs git. Start a coding session with /coding first.`);
    const root = snapshot.cwd;
    let instruction: string;
    if (command === 'commit')
      instruction = commitInstruction({ ...loadGitPrefs(), session: snapshot.id });
    else if (command === 'branch') {
      if (!args) throw new Error('Usage: /branch <name>');
      instruction = branchInstruction(args);
    } else {
      const branch = currentBranch(root),
        base = args || defaultBase(root);
      if (!branch) throw new Error('/pr needs a checked-out branch, not a detached HEAD.');
      if (branch === base)
        throw new Error(`You are on ${base}. Create a branch first with /branch <name>.`);
      if (!validBranchName(base)) throw new Error(`"${base}" is not a valid branch name.`);
      instruction = prInstruction({ tool: forgeTool(root), branch, base });
    }
    await ctx.client.submit(instruction);
    ctx.setTab('conversation');
  },
};

const init: SlashCommand = {
  names: ['init'],
  session: true,
  async run(ctx, _args, _name, snapshot) {
    if (!snapshot.capabilities.includes('local-coding-reviewed'))
      throw new Error('/init writes a file. Start a coding session with /coding first.');
    await ctx.client.submit(INIT_INSTRUCTION);
    ctx.setTab('conversation');
  },
};

export const GIT_COMMANDS: readonly SlashCommand[] = [git, init];
