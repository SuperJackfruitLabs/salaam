import type { ExecutionBackend } from '../../src/coding-executor.js';
export class TaskFixtureBackend implements ExecutionBackend {
  constructor(launchLog?: string);
  profileDigest: string;
  engineId: string;
  evidence: Record<string, unknown>;
  runs: Map<string, { command: string; launches: number }>;
  holding: boolean;
  exitOverride: number | null;
  create(source: string, run: string): Promise<string>;
  start(container: string, source: string, run: string): Promise<void>;
  ready(container: string, run: string): Promise<void>;
  exec(container: string, run: string, command: string, cwd: string): Promise<string>;
  launch(exec: string): Promise<void>;
  status(
    container: string,
    run: string,
    exec: string,
  ): Promise<{ running: boolean; exit: number | null }>;
  logs(container: string, run: string): Promise<{ content: string; bytes: number }>;
  cleanup(run: string): Promise<void>;
}
