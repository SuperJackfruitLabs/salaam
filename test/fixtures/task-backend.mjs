import { appendFileSync } from 'node:fs';
/** Simulated executor API. No host repository command is executed. */
export class TaskFixtureBackend {
  profileDigest = 'task-fixture-profile';
  engineId = 'task-fixture-engine';
  evidence = { fixture: true, execution: 'simulated' };
  runs = new Map();
  holding = false;
  exitOverride = null;
  constructor(launchLog) {
    this.launchLog = launchLog;
  }
  async create(_source, run) {
    if (this.runs.has(run)) throw Error('Duplicate fixture create');
    this.runs.set(run, { command: '', launches: 0 });
    if (this.launchLog)
      appendFileSync(this.launchLog, JSON.stringify({ phase: 'create', run }) + '\n');
    return run;
  }
  async start() {}
  async ready() {}
  async exec(_container, run, command) {
    this.runs.get(run).command = command;
    return run;
  }
  async launch(exec) {
    this.runs.get(exec).launches++;
    if (this.launchLog)
      appendFileSync(this.launchLog, JSON.stringify({ phase: 'launch', run: exec }) + '\n');
  }
  async status(_container, run) {
    return {
      running: this.holding,
      exit: this.holding
        ? null
        : (this.exitOverride ?? (this.runs.get(run)?.command.includes('fail') ? 1 : 0)),
    };
  }
  async logs() {
    const output = 'Fixture executor output; no host command executed.\n';
    return { content: Buffer.from(output).toString('base64'), bytes: Buffer.byteLength(output) };
  }
  async cleanup() {}
}
