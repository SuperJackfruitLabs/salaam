import type { ProviderRoute, SessionSnapshot } from '../../core/index.js';
import type { CustomCommand } from '../../runtime/index.js';
import type { SessionContext } from '../panels/context.js';

/** What a slash command needs from the app, beyond what its panels do. */
export interface CommandContext extends SessionContext {
  /** Leave: detach from the session; its work continues in the service. */
  finish(): void;
  /** The keys for where you are. */
  help(): void;
  applyRoute(route: ProviderRoute): Promise<void>;
  /** This workspace's and your own custom commands, and the files that could not be read. */
  customCommands(): CustomCommand[];
  readonly customCommandProblems: string[];
  toggleTheme(): void;
  toggleRail(): void;
}

/** One slash command, or a few that share their handling. Names and descriptions live in
 * SLASH_COMMANDS (core/slash-commands.ts); a handler only says what its names do. */
export type SlashCommand =
  | {
      readonly names: readonly string[];
      /** Runs without an open session. */
      readonly session: false;
      run(ctx: CommandContext, args: string, name: string): Promise<void> | void;
    }
  | {
      readonly names: readonly string[];
      /** Needs an open session; the registry refuses the command without one. */
      readonly session: true;
      run(
        ctx: CommandContext,
        args: string,
        name: string,
        snapshot: SessionSnapshot,
      ): Promise<void> | void;
    };
