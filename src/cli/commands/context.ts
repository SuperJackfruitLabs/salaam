/** What a command group gets from the CLI: its arguments and where the service is. */
export interface CliContext {
  /** The arguments after --state and --foreground; option() removes what it reads. */
  readonly args: string[];
  /** The value after `name`, removed from args with it; a flag without a value throws. */
  readonly option: (name: string) => string | undefined;
  /** The state directory: --state, SALAAM_STATE_DIR or the default. */
  readonly state: string;
  /** --state as given, when it was. */
  readonly explicitState: string | undefined;
  /** The service's operator socket in the state directory. */
  readonly socket: string;
  readonly foreground: boolean;
  readonly group: string | undefined;
  readonly verb: string | undefined;
  readonly id: string | undefined;
}

/** One command group's handler: it handles the command and returns true, or returns false so the
 * next group may. The CLI tries them in order. */
export type CliCommand = (ctx: CliContext) => Promise<boolean>;
