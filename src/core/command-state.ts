/** A command run in one of these states has finished: it starts no more work and its output is
 * complete. The service and its clients read the same list. */
export const commandTerminal = (state: string): boolean =>
  ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limited', 'interrupted'].includes(
    state,
  );
