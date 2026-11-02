// A failure rule recognises one exact shape of a stopped run that Salaam can prove, from the
// journal alone, and returns the evidence a retirement records for it. Rules only read. A caller
// asks its rules in a fixed order and takes the first that matches; the order is part of what
// the evidence digest means, so it lives in one ordered list per call site.
import type { AgentPodBinding, WorkTask } from '../../core/index.js';
import type { SQLOutputValue } from 'node:sqlite';
import type { Store } from '../../store/index.js';

/** A journal row as SQLite returns it, read field by field. */
export type Row = Record<string, SQLOutputValue>;
/** A JSON document saved in the journal (an artifact, a receipt or a payload), read field by field. */
export type Json = Record<string, unknown>;

/** The journal a rule reads. */
export type RuleStore = Pick<Store, 'db'>;

/** A stopped run as the known-effects rules see it: its root session and binding, its task, the
 * task's runtime row and the root session's attempts (in the order SQLite returns them). */
export interface StoppedRun {
  readonly session: string;
  readonly binding: AgentPodBinding;
  readonly task: WorkTask;
  readonly runtime: Row | undefined;
  readonly attempts: Row[];
}

export interface FailureRule<Input = StoppedRun> {
  /** The key the evidence is recorded under. */
  readonly name: string;
  /** The evidence when the run is exactly this shape, or null. */
  match(input: Input): unknown;
}

/** A rule that can say which part of its shape a run missed, as a closed code. The code is that
 * of the last match() that returned null, or null after a match. */
export interface MissReporting<Code extends string> {
  readonly miss: Code | null;
}
