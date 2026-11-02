import type { WorkerBinding } from '../core/index.js';

/** The team work members the supervisor's bridge calls for a child's team messages. Task team
 * work implements it; the service installs it. */
export interface TeamBridge {
  assert(binding: WorkerBinding): unknown;
  send(
    taskId: string,
    sender: string,
    recipient: string,
    text: string,
    messageId: string,
    authorize: () => void,
  ): unknown;
  receive(recipient: string, request: string, authorize: () => void): unknown;
  acknowledge(recipient: string, id: string, request: string, authorize: () => void): unknown;
}
