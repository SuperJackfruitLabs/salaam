import type { Api } from '@earendil-works/pi-ai';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
const token = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** A normalized zero is not evidence that a provider reported zero usage. */
export class ProviderUsageReceipt {
  private input = false;
  private output = false;
  observe(api: Api, value: unknown) {
    const event = record(value);
    let input: unknown, output: unknown;
    switch (api) {
      case 'anthropic-messages': {
        const usage = record(
          event.type === 'message_start' ? record(event.message).usage : event.usage,
        );
        input = usage.input_tokens;
        output = event.type === 'message_delta' ? usage.output_tokens : undefined;
        break;
      }
      case 'google-generative-ai':
      case 'google-vertex': {
        const usage = record(event.usageMetadata);
        input = usage.promptTokenCount;
        output = usage.candidatesTokenCount;
        break;
      }
      case 'bedrock-converse-stream': {
        const usage = record(record(event.metadata).usage);
        input = usage.inputTokens;
        output = usage.outputTokens;
        break;
      }
      case 'openai-responses':
      case 'azure-openai-responses':
      case 'openai-codex-responses': {
        const usage = record(record(event.response).usage);
        input = usage.input_tokens;
        output = usage.output_tokens;
        break;
      }
      case 'pi-messages': {
        const usage = record(event.usage);
        input = usage.input;
        output = usage.output;
        break;
      }
      default: {
        const usage = record(event.usage);
        input = usage.prompt_tokens ?? usage.promptTokens;
        output = usage.completion_tokens ?? usage.completionTokens;
        break;
      }
    }
    this.input ||= token(input);
    this.output ||= token(output);
  }
  get complete() {
    return this.input && this.output;
  }
}
