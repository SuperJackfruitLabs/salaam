// How a dispatched turn's records decide its outcome: an assistant message that did not end its
// turn normally, or a failed tool call where tool failures fail the turn.
import {
  ServiceError,
  acpFailure,
  object,
  parseAcpFailure,
  providerOutcome,
  redactFailureText,
  type AttemptOutcome,
  type ProviderRoute,
} from '../core/index.js';

/** The turn's outcome after one more Pi record. `toolErrorsFail` says, when a tool call failed,
 * whether that fails the turn; it is asked only then. */
export function turnOutcome(
  value: Record<string, unknown>,
  outcome: AttemptOutcome | undefined,
  route: ProviderRoute,
  secrets: string[] | undefined,
  toolErrorsFail: () => boolean,
): AttemptOutcome | undefined {
  if (value.type === 'message_end') {
    const message = object(value.message);
    if (message.role === 'assistant') {
      const explicit = parseAcpFailure(message.salaamFailure);
      const candidate: AttemptOutcome = explicit
        ? {
            version: 1,
            stopReason:
              explicit.kind === 'refusal'
                ? 'refusal'
                : explicit.kind === 'max_tokens'
                  ? 'max_tokens'
                  : 'error',
            failure: { ...explicit, message: redactFailureText(explicit.message, secrets) },
          }
        : providerOutcome(
            String(message.stopReason),
            String(message.errorMessage ?? ''),
            route,
            undefined,
            secrets,
          );
      if (candidate.stopReason !== 'end_turn') outcome = candidate;
    }
  }
  if (value.type === 'tool_execution_end' && value.isError === true && toolErrorsFail())
    outcome ??= {
      version: 1,
      stopReason: 'error',
      failure: acpFailure(new ServiceError('tool_failed', toolFailureMessage(value.toolName))),
    };
  return outcome;
}

/** Names the failing tool (never its arguments or output), so a failed step says which call
 * failed it. Only a plain tool identifier is echoed. */
export function toolFailureMessage(toolName: unknown): string {
  return typeof toolName === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(toolName)
    ? `Tool execution failed (tool ${toolName})`
    : 'Tool execution failed';
}
