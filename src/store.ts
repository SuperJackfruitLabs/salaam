import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolvedToolkitCallSql } from './toolkit-resolutions.js';
import { EventEmitter } from 'node:events';
import { UsageLedger } from './usage.js';
import { WorkerBoundary } from './worker-boundary.js';
import { ExecutionAuthority } from './execution-authority.js';
import { OFFLINE_ROUTE, type ProviderRoute } from './provider-config.js';
import { canonical } from './protocol.js';
import { acpFailure, type AttemptOutcome } from './acp-outcome.js';
import {
  digest,
  ServiceError,
  type Session,
  type DurableEvent,
  type WorkerState,
  type Attempt,
  type Submission,
  type Controller,
  type ControlLease,
  type ControlView,
  type SessionSnapshot,
  textDigest,
  type Operation,
  type Approval,
} from './protocol.js';

export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  readonly usage = new UsageLedger(this);
  readonly workerBoundary = new WorkerBoundary(this);
  readonly execution = new ExecutionAuthority(this);
  agentpodAuthorityCheck?: (session: string) => void;
  nativeResourceCheck?: (session: string) => void;
  requireAgentPodAuthority = false;
  reconcileCompactions?: (id: string) => void;
  finishChild?: (attempt: Attempt) => void;
  projectTaskAttempt?: (attempt: Attempt) => void;
  teamSnapshot?: (session: string) => unknown;
  guardTaskSubmission?: (session: string, step?: string) => void;
  cancelChildren?: (attempt: string) => void;
  recordTaskMutation?: (
    session: string,
    mutation: string,
    before: import('./workspaces.js').WorkspaceTree,
    after: import('./workspaces.js').WorkspaceTree,
  ) => void;
  taskGrantCheck?: (session: string) => void;
  jobGrantCheck?: (session: string) => void;
  taskModelAdmission?: (
    session: string,
    attempt: string | undefined,
    input: number,
    output: number,
  ) => void;
  taskBudgetDenied?: (session: string, error: unknown) => void;
  taskChildReserve?: (session: string, attempt: string, count: number) => void;
  taskChildFinished?: (attempt: string) => void;
  taskCommandAdmission?: (session: string) => void;
  taskRemainingRuntime?: (session: string) => number;
  private committed: DurableEvent[] | null = null;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;`,
    );
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > 30) {
      this.db.close();
      throw new ServiceError('schema_too_new', 'Database schema is newer than this service');
    }
    if (version === 0)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'stopped', epoch INTEGER NOT NULL DEFAULT 0, pi_session_id TEXT NOT NULL UNIQUE,
        pi_session_file TEXT, pi_cursor TEXT, pi_leaf TEXT, error TEXT, capabilities TEXT NOT NULL DEFAULT '[]', seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE requests (actor TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor,id));
      CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL, causation_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      CREATE TABLE workers (session_id TEXT NOT NULL REFERENCES sessions(id), epoch INTEGER NOT NULL, boot_id TEXT NOT NULL,
        pid INTEGER, identity TEXT, state TEXT NOT NULL, PRIMARY KEY(session_id,epoch));
      CREATE TABLE submissions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'accepted');
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), digest TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE pi_entries (session_id TEXT NOT NULL REFERENCES sessions(id), entry_id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(session_id,entry_id));
      PRAGMA user_version=1; COMMIT;`);
    if (version < 2) {
      try {
        this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE submissions ADD COLUMN attempt_id TEXT;
        CREATE TABLE attempts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
          submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id), state TEXT NOT NULL,
          worker_epoch INTEGER, error TEXT, result TEXT, continues_attempt_id TEXT REFERENCES attempts(id), resolved_by TEXT);
        CREATE INDEX attempt_queue ON attempts(session_id,state);
        CREATE TABLE controls (session_id TEXT PRIMARY KEY REFERENCES sessions(id), client_id TEXT, token_hash TEXT,
          epoch INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0);`);
        for (const row of this.db.prepare('SELECT id,session_id FROM submissions').all() as {
          id: string;
          session_id: string;
        }[]) {
          const attempt = randomUUID();
          this.db
            .prepare(
              "INSERT INTO attempts(id,session_id,submission_id,state) VALUES (?,?,?,'accepted')",
            )
            .run(attempt, row.session_id, row.id);
          this.db.prepare('UPDATE submissions SET attempt_id=? WHERE id=?').run(attempt, row.id);
        }
        this.db.exec('PRAGMA user_version=2; COMMIT;');
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        this.db.close();
        throw error;
      }
    }
    if (version < 3) {
      try {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE operations (id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),attempt_id TEXT NOT NULL REFERENCES attempts(id),
            worker_epoch INTEGER NOT NULL,tool_call_id TEXT NOT NULL,kind TEXT NOT NULL,action_key TEXT NOT NULL UNIQUE,
            argument_digest TEXT NOT NULL,operation_digest TEXT NOT NULL,target TEXT NOT NULL,value TEXT NOT NULL,target_version TEXT NOT NULL,
            policy_digest TEXT NOT NULL,connector TEXT NOT NULL,replay TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL,
            receipt TEXT,error TEXT,resolution TEXT,UNIQUE(session_id,worker_epoch,tool_call_id));
          CREATE INDEX operation_recovery ON operations(session_id,state);
          CREATE TABLE approvals(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),session_id TEXT NOT NULL REFERENCES sessions(id),
            worker_epoch INTEGER NOT NULL,operation_digest TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,actor_scope TEXT NOT NULL,
            policy_digest TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,decision TEXT,decided_by TEXT);
          CREATE TABLE approval_dialogs(approval_id TEXT PRIMARY KEY REFERENCES approvals(id),session_id TEXT NOT NULL,worker_epoch INTEGER NOT NULL,
            pi_request_id TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(session_id,worker_epoch,pi_request_id));
          CREATE TABLE cancellations(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),requested_by TEXT NOT NULL);
          PRAGMA user_version=3;COMMIT;`);
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        this.db.close();
        throw error;
      }
    }
    try {
      this.migrateChildren();
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 5
      )
        this.db.exec(
          `BEGIN IMMEDIATE; CREATE TABLE session_routes(session_id TEXT PRIMARY KEY REFERENCES sessions(id),route TEXT NOT NULL); PRAGMA user_version=5; COMMIT;`,
        );
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 6
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE task_heads(session_id TEXT PRIMARY KEY REFERENCES sessions(id),version INTEGER NOT NULL DEFAULT 0,compaction_cursor TEXT);
          CREATE TABLE task_facts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),version INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,
            supersedes TEXT UNIQUE REFERENCES task_facts(id),artifact_id TEXT REFERENCES artifacts(id),source TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(session_id,version));
          CREATE TABLE compactions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),epoch INTEGER NOT NULL,task_version INTEGER NOT NULL,state TEXT NOT NULL,cursor TEXT,error TEXT);
          CREATE TABLE compaction_cancellations(id TEXT PRIMARY KEY REFERENCES compactions(id));
          PRAGMA user_version=6;COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 7
      )
        this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),source TEXT NOT NULL,root TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,baseline TEXT NOT NULL REFERENCES artifacts(id),state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspace_mutations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),request_key TEXT NOT NULL,input_digest TEXT NOT NULL,expected_revision INTEGER NOT NULL,before_digest TEXT NOT NULL,after_digest TEXT NOT NULL,artifact_id TEXT NOT NULL REFERENCES artifacts(id),before_root TEXT NOT NULL,after_root TEXT NOT NULL,state TEXT NOT NULL,error TEXT,UNIQUE(workspace_id,request_key));
        CREATE TABLE IF NOT EXISTS command_runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),attempt_id TEXT REFERENCES attempts(id),step_key TEXT NOT NULL,input_digest TEXT NOT NULL,command TEXT NOT NULL,cwd TEXT NOT NULL,workspace_revision INTEGER NOT NULL,workspace_digest TEXT NOT NULL,profile_digest TEXT NOT NULL,engine_id TEXT NOT NULL,snapshot_artifact TEXT NOT NULL REFERENCES artifacts(id),container_id TEXT,exec_id TEXT,state TEXT NOT NULL,resume_state TEXT,exit_code INTEGER,output TEXT NOT NULL DEFAULT '',result_artifact TEXT,error TEXT,created_at INTEGER NOT NULL,deadline INTEGER NOT NULL,cancelled INTEGER NOT NULL DEFAULT 0,UNIQUE(session_id,step_key));
        PRAGMA user_version=7; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 8
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE durable_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),revision INTEGER NOT NULL,plan_revision INTEGER NOT NULL,state TEXT NOT NULL,objective TEXT NOT NULL,constraints_json TEXT NOT NULL,reason TEXT NOT NULL);
          CREATE TABLE task_plans(task_id TEXT NOT NULL REFERENCES durable_tasks(id),revision INTEGER NOT NULL,document TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(task_id,revision));
          CREATE TABLE task_steps(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES durable_tasks(id),step_key TEXT NOT NULL,ordinal INTEGER NOT NULL,title TEXT NOT NULL,instruction TEXT NOT NULL,dependencies TEXT NOT NULL,state TEXT NOT NULL,attempt_id TEXT REFERENCES attempts(id),review TEXT,UNIQUE(task_id,step_key),UNIQUE(task_id,ordinal));
          CREATE TABLE task_step_attempts(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),step_id TEXT NOT NULL REFERENCES task_steps(id),plan_revision INTEGER NOT NULL,instruction TEXT NOT NULL);
          PRAGMA user_version=8; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 9
      )
        this.db.exec(`BEGIN IMMEDIATE;
          ALTER TABLE task_steps ADD COLUMN checks TEXT NOT NULL DEFAULT '[]';
          CREATE TABLE task_runtime(task_id TEXT PRIMARY KEY REFERENCES durable_tasks(id),started_at INTEGER,blocked_reason TEXT,requests_spent INTEGER NOT NULL DEFAULT 0,reserved_requests INTEGER NOT NULL DEFAULT 0,token_units INTEGER NOT NULL DEFAULT 0,reserved_tokens INTEGER NOT NULL DEFAULT 0,verification_runs INTEGER NOT NULL DEFAULT 0,auto_enabled INTEGER NOT NULL DEFAULT 0,remaining_steps INTEGER NOT NULL DEFAULT 0,auto_plan_revision INTEGER NOT NULL DEFAULT 0,auto_compact INTEGER NOT NULL DEFAULT 0,auto_error TEXT,auto_binding TEXT,auto_epoch INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE task_reservations(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),task_id TEXT NOT NULL REFERENCES durable_tasks(id),remaining_requests INTEGER NOT NULL,remaining_tokens INTEGER NOT NULL);
          CREATE TABLE task_checks(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES durable_tasks(id),step_id TEXT REFERENCES task_steps(id),check_key TEXT NOT NULL,plan_revision INTEGER NOT NULL,workspace_id TEXT NOT NULL,workspace_revision INTEGER NOT NULL,workspace_digest TEXT NOT NULL,profile_digest TEXT NOT NULL,engine_id TEXT NOT NULL,command_run_id TEXT REFERENCES command_runs(id),state TEXT NOT NULL,artifact_id TEXT REFERENCES artifacts(id));
          CREATE TABLE task_completions(task_id TEXT PRIMARY KEY REFERENCES durable_tasks(id),plan_revision INTEGER NOT NULL,workspace_id TEXT,workspace_revision INTEGER,workspace_digest TEXT,artifact_id TEXT NOT NULL REFERENCES artifacts(id),state TEXT NOT NULL,exception TEXT);
          CREATE TABLE task_checkpoints(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES durable_tasks(id),workspace_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,tree_artifact TEXT NOT NULL REFERENCES artifacts(id),mutation_cursor INTEGER NOT NULL);
          CREATE TABLE task_mutations(mutation_id TEXT PRIMARY KEY REFERENCES workspace_mutations(id),task_id TEXT NOT NULL REFERENCES durable_tasks(id),change_artifact TEXT NOT NULL REFERENCES artifacts(id));
          CREATE TABLE task_restores(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES durable_tasks(id),checkpoint_id TEXT NOT NULL REFERENCES task_checkpoints(id),before_artifact TEXT NOT NULL REFERENCES artifacts(id),after_artifact TEXT NOT NULL REFERENCES artifacts(id),expected_revision INTEGER NOT NULL,expected_digest TEXT NOT NULL,mutation_id TEXT,state TEXT NOT NULL,conflicts TEXT NOT NULL);
          CREATE TABLE task_grants(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES durable_tasks(id),step_id TEXT NOT NULL REFERENCES task_steps(id),plan_revision INTEGER NOT NULL,expected_revision INTEGER NOT NULL,state TEXT NOT NULL,binding TEXT NOT NULL,epoch INTEGER NOT NULL,UNIQUE(task_id,step_id,plan_revision,epoch));
          CREATE TABLE task_compactions(task_id TEXT NOT NULL REFERENCES durable_tasks(id),step_id TEXT NOT NULL REFERENCES task_steps(id),plan_revision INTEGER NOT NULL,request_id TEXT NOT NULL,compaction_id TEXT,task_version INTEGER NOT NULL,skip_reason TEXT,epoch INTEGER NOT NULL,PRIMARY KEY(task_id,step_id,plan_revision,epoch));
          INSERT INTO task_runtime(task_id,started_at,requests_spent,token_units)
            SELECT t.id,CASE WHEN count(u.source_key)>0 THEN unixepoch('now')*1000 ELSE NULL END,count(u.source_key),count(u.source_key)*139264
            FROM durable_tasks t LEFT JOIN usage_observations u ON (u.session_id=t.session_id OR u.session_id IN (SELECT child_session FROM child_tasks WHERE parent_session=t.session_id)) AND u.provider!='salaam-checkpoint' GROUP BY t.id;
          INSERT INTO task_reservations(attempt_id,task_id,remaining_requests,remaining_tokens)
            SELECT c.child_attempt,t.id,max(0,c.budget-(SELECT count(*) FROM usage_observations WHERE session_id=c.child_session)),max(0,c.budget-(SELECT count(*) FROM usage_observations WHERE session_id=c.child_session))*139264 FROM child_tasks c JOIN durable_tasks t ON t.session_id=c.parent_session WHERE c.state!='completed';
          UPDATE task_runtime SET reserved_requests=(SELECT coalesce(sum(remaining_requests),0) FROM task_reservations WHERE task_id=task_runtime.task_id),reserved_tokens=(SELECT coalesce(sum(remaining_tokens),0) FROM task_reservations WHERE task_id=task_runtime.task_id);
          PRAGMA user_version=9; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 10
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE jobs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES durable_tasks(id),session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),name TEXT NOT NULL,revision INTEGER NOT NULL,binding TEXT NOT NULL,binding_digest TEXT NOT NULL,max_steps INTEGER NOT NULL,compact INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
          CREATE TABLE job_occurrences(id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),occurrence_key TEXT NOT NULL,binding_digest TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
          PRAGMA user_version=10; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 11
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE recurring_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),name TEXT NOT NULL,revision INTEGER NOT NULL,template TEXT NOT NULL,template_digest TEXT NOT NULL,state TEXT NOT NULL,next_due INTEGER,created_at INTEGER NOT NULL);
          CREATE TABLE schedule_revisions(job_id TEXT NOT NULL REFERENCES recurring_jobs(id),revision INTEGER NOT NULL,definition TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(job_id,revision));
          CREATE TABLE recurring_occurrences(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES recurring_jobs(id),occurrence_key TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),job_run_id TEXT UNIQUE REFERENCES jobs(id),schedule_revision INTEGER NOT NULL,due_at INTEGER,state TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,UNIQUE(job_id,occurrence_key));
          CREATE TABLE operator_inbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),source_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,detail TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,ack_revision INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
          PRAGMA user_version=11; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 12
      ) {
        this.db.exec('BEGIN IMMEDIATE');
        this.workerBoundary.migrate();
        this.db.exec('PRAGMA user_version=12; COMMIT;');
      }
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 13
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE agent_grants(id TEXT PRIMARY KEY,owner_session TEXT NOT NULL REFERENCES sessions(id),profile_id TEXT NOT NULL,document TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL);
          CREATE TABLE specialist_reports(worker_id TEXT PRIMARY KEY,input_digest TEXT NOT NULL,artifact_id TEXT NOT NULL REFERENCES artifacts(id));
          PRAGMA user_version=13; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 14
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE team_assignments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES durable_tasks(id),step_id TEXT NOT NULL REFERENCES task_steps(id),plan_revision INTEGER NOT NULL,profile_id TEXT NOT NULL,grant_id TEXT NOT NULL REFERENCES agent_grants(id),budget INTEGER NOT NULL,generation INTEGER NOT NULL DEFAULT 0,child_id TEXT REFERENCES child_tasks(id),superseded INTEGER NOT NULL DEFAULT 0);
          CREATE UNIQUE INDEX team_active_step ON team_assignments(step_id) WHERE superseded=0;
          CREATE TABLE team_messages(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES durable_tasks(id),sender TEXT NOT NULL,recipient TEXT NOT NULL REFERENCES team_assignments(id),text TEXT NOT NULL,input_digest TEXT NOT NULL,created_at INTEGER NOT NULL,delivered_at INTEGER,acknowledged_at INTEGER);
          PRAGMA user_version=14; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 15
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE worker_integrations(id TEXT PRIMARY KEY,parent_session TEXT NOT NULL REFERENCES sessions(id),child_id TEXT NOT NULL UNIQUE REFERENCES child_tasks(id),worker_id TEXT NOT NULL,patch_digest TEXT NOT NULL,before_revision INTEGER NOT NULL,before_digest TEXT NOT NULL,after_artifact TEXT NOT NULL REFERENCES artifacts(id),state TEXT NOT NULL,mutation_id TEXT REFERENCES workspace_mutations(id),mutation_key TEXT NOT NULL UNIQUE,generation INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE team_rejections(step_id TEXT NOT NULL REFERENCES task_steps(id),attempt_id TEXT NOT NULL REFERENCES attempts(id),request_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(step_id,attempt_id));
          PRAGMA user_version=15; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 16
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE external_assignments(assignment_id TEXT PRIMARY KEY REFERENCES team_assignments(id),runtime TEXT NOT NULL,digest TEXT NOT NULL);
          CREATE TABLE external_runs(child_id TEXT PRIMARY KEY REFERENCES child_tasks(id),run_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,epoch INTEGER NOT NULL,checkpoint TEXT,receipt TEXT,stopped INTEGER NOT NULL DEFAULT 0,error TEXT,result TEXT,import_artifact TEXT REFERENCES artifacts(id));
          CREATE TABLE task_invocations(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),task_id TEXT NOT NULL REFERENCES durable_tasks(id),runtime_id TEXT NOT NULL,input_digest TEXT NOT NULL,created_at INTEGER NOT NULL);
          CREATE TABLE external_model_requests(id TEXT PRIMARY KEY,child_id TEXT NOT NULL REFERENCES external_runs(child_id),input_bytes INTEGER NOT NULL,output_bound INTEGER NOT NULL);
          PRAGMA user_version=16; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 17
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE a2a_inbound(id TEXT PRIMARY KEY,peer TEXT NOT NULL,tenant TEXT NOT NULL,message_id TEXT NOT NULL,input_digest TEXT NOT NULL,assignment_id TEXT NOT NULL UNIQUE REFERENCES team_assignments(id),grant_digest TEXT NOT NULL,context_id TEXT NOT NULL UNIQUE,child_id TEXT NOT NULL UNIQUE REFERENCES child_tasks(id),created_at INTEGER NOT NULL,skill TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,UNIQUE(peer,tenant,message_id));
          PRAGMA user_version=17; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 18
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE session_revocations(session_id TEXT PRIMARY KEY REFERENCES sessions(id),receipt TEXT NOT NULL);
          PRAGMA user_version=18; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 19
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE agentpod_admissions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),hub_session_id TEXT NOT NULL UNIQUE,run_key TEXT NOT NULL UNIQUE,binding TEXT NOT NULL,digest TEXT NOT NULL,pins_digest TEXT NOT NULL,lease_sequence INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,boot_id TEXT,monotonic_deadline REAL,state TEXT NOT NULL DEFAULT 'pending');
          CREATE TABLE agentpod_station_epochs(station_id TEXT PRIMARY KEY,occupancy_epoch INTEGER NOT NULL,principal_id TEXT NOT NULL);
          PRAGMA user_version=19; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 20
      )
        this.db.exec(`BEGIN IMMEDIATE;
          ALTER TABLE attempts ADD COLUMN outcome TEXT;
          CREATE TABLE turn_cancellations(request_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),target_request_id TEXT,attempt_ids TEXT NOT NULL,receipt TEXT NOT NULL,requested_at INTEGER NOT NULL);
          CREATE INDEX turn_cancellations_target ON turn_cancellations(session_id,target_request_id);
          PRAGMA user_version=20; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 21
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE mcp_assignments(session_id TEXT PRIMARY KEY REFERENCES sessions(id),credential_generation INTEGER NOT NULL,assignment_digest TEXT NOT NULL,view TEXT NOT NULL);
          CREATE TABLE mcp_calls(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),worker_epoch INTEGER NOT NULL,attempt_id TEXT NOT NULL REFERENCES attempts(id),tool_call_id TEXT NOT NULL,input_digest TEXT NOT NULL,binding_digest TEXT NOT NULL,profile_digest TEXT NOT NULL,assignment_digest TEXT NOT NULL,credential_generation INTEGER NOT NULL,server_name TEXT NOT NULL,tool_name TEXT NOT NULL,policy TEXT NOT NULL,arguments_json TEXT NOT NULL,operation_id TEXT UNIQUE REFERENCES operations(id),state TEXT NOT NULL,result_artifact TEXT REFERENCES artifacts(id),error TEXT,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,UNIQUE(session_id,worker_epoch,tool_call_id));
          CREATE INDEX mcp_calls_attempt ON mcp_calls(session_id,attempt_id);
          PRAGMA user_version=21; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 22
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE toolkit_resources(id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),root_digest TEXT NOT NULL,profile_digest TEXT NOT NULL,state_dir TEXT NOT NULL,input_digest TEXT NOT NULL,spec TEXT NOT NULL,owner_boot TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','launching','running','unconfirmed','stopped')),pid INTEGER CHECK(pid IS NULL OR pid>0),identity TEXT,stop_digest TEXT,stop_receipt TEXT,revision INTEGER NOT NULL DEFAULT 0,CHECK(state!='running' OR (pid IS NOT NULL AND identity IS NOT NULL)),CHECK((state='stopped')=(stop_digest IS NOT NULL AND stop_receipt IS NOT NULL)));
          CREATE UNIQUE INDEX toolkit_resources_root_owner ON toolkit_resources(root_digest) WHERE state!='stopped';
          CREATE UNIQUE INDEX toolkit_resources_state_owner ON toolkit_resources(state_dir) WHERE state!='stopped';
          PRAGMA user_version=22; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 23
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE toolkit_owners(resource_id TEXT PRIMARY KEY NOT NULL REFERENCES toolkit_resources(id),key_digest TEXT NOT NULL UNIQUE CHECK(length(key_digest)=64));
          CREATE TABLE toolkit_calls(id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),worker_epoch INTEGER NOT NULL,attempt_id TEXT NOT NULL REFERENCES attempts(id),tool_call_id TEXT NOT NULL,resource_id TEXT NOT NULL REFERENCES toolkit_resources(id),request_json TEXT NOT NULL,request_digest TEXT NOT NULL,context_digest TEXT NOT NULL,action_pin TEXT NOT NULL,operation_id TEXT UNIQUE REFERENCES operations(id),state TEXT NOT NULL CHECK(state IN ('prepared','delivered','dispatching','pending','denied','returned','outcome_unknown','cancelled')),receipt_json TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),revision INTEGER NOT NULL DEFAULT 1,UNIQUE(session_id,worker_epoch,tool_call_id));
          CREATE INDEX toolkit_calls_resource ON toolkit_calls(resource_id,state);
          CREATE UNIQUE INDEX toolkit_calls_active_resource ON toolkit_calls(resource_id) WHERE state IN ('prepared','delivered','dispatching','pending','outcome_unknown');
          PRAGMA user_version=23; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 24
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE toolkit_cleanup_profiles(resource_id TEXT PRIMARY KEY NOT NULL REFERENCES toolkit_resources(id),profile_path TEXT NOT NULL,profile_digest TEXT NOT NULL CHECK(length(profile_digest)=64));
          PRAGMA user_version=24; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 25
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE toolkit_resolutions(id TEXT PRIMARY KEY NOT NULL,request_id TEXT NOT NULL UNIQUE,call_id TEXT NOT NULL UNIQUE REFERENCES toolkit_calls(id),operation_id TEXT UNIQUE REFERENCES operations(id),call_revision INTEGER NOT NULL,request_digest TEXT NOT NULL,context_json TEXT NOT NULL,context_digest TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','native_settled','committed')),native_receipt_json TEXT,revision INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE toolkit_resolution_controls(id TEXT PRIMARY KEY NOT NULL,resolution_id TEXT NOT NULL REFERENCES toolkit_resolutions(id),resource_id TEXT NOT NULL UNIQUE REFERENCES toolkit_resources(id),control_json TEXT NOT NULL,result_json TEXT,state TEXT NOT NULL CHECK(state IN ('prepared','returned','outcome_unknown')));
          PRAGMA user_version=25; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 26
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE station_calls(id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),worker_epoch INTEGER NOT NULL,attempt_id TEXT NOT NULL REFERENCES attempts(id),tool_call_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('patch','check','read')),input_digest TEXT NOT NULL,root_digest TEXT NOT NULL,configuration_digest TEXT NOT NULL,args_json TEXT NOT NULL,operation_id TEXT UNIQUE REFERENCES operations(id),state TEXT NOT NULL CHECK(state IN ('prepared','dispatching','returned','failed','outcome_unknown','cancelled')),revision INTEGER NOT NULL DEFAULT 1,result_json TEXT,helper_pid INTEGER,helper_identity TEXT,helper_state TEXT NOT NULL DEFAULT 'none',helper_stop_json TEXT,UNIQUE(session_id,worker_epoch,tool_call_id));
          CREATE TABLE station_units(id TEXT PRIMARY KEY NOT NULL,session_id TEXT REFERENCES sessions(id),call_id TEXT UNIQUE REFERENCES station_calls(id),context_digest TEXT NOT NULL,config_json TEXT NOT NULL,snapshot_path TEXT NOT NULL,output_path TEXT NOT NULL,unit_json TEXT,state TEXT NOT NULL CHECK(state IN ('prepared','launching','running','unconfirmed','stopped')),stop_json TEXT);
          PRAGMA user_version=26; COMMIT;`);
      if (
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 27
      )
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE local_calls(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),attempt_id TEXT NOT NULL REFERENCES attempts(id),epoch INTEGER NOT NULL,tool_call TEXT NOT NULL,input_digest TEXT NOT NULL,root TEXT NOT NULL,args TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),state TEXT NOT NULL,result TEXT,pid INTEGER,identity TEXT,UNIQUE(session_id,epoch,tool_call));
          PRAGMA user_version=27; COMMIT;`);
      if (version === 30) this.db.prepare('SELECT task_check_id FROM station_calls LIMIT 0').all();
      // Strict work is a lazy migration: a schema29 database must retain its mapping.
      if (version >= 29)
        this.db
          .prepare(
            'SELECT run_key,session_id,task_id,request_id,admission_json,verification_json FROM agentpod_work LIMIT 0',
          )
          .all();
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }
  /** Startup-only migration: verification has task ownership, never a fabricated
   * model attempt. Rebuild with FK checks before commit; rollback retains v29. */
  enableStationTaskChecks(): void {
    if (this.db.isTransaction) throw Error('Station schema migration requires an idle journal');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version >= 30) {
      this.db.prepare('SELECT task_check_id FROM station_calls LIMIT 0').all();
      return;
    }
    const original = String(
      this.db.prepare("SELECT sql FROM sqlite_master WHERE name='station_calls'").get()!.sql,
    );
    const next = original
      .replace('CREATE TABLE station_calls', 'CREATE TABLE station_calls_next')
      .replace(
        'attempt_id TEXT NOT NULL REFERENCES attempts(id)',
        'attempt_id TEXT REFERENCES attempts(id)',
      )
      .replace(
        'UNIQUE(session_id,worker_epoch,tool_call_id)',
        "task_check_id TEXT REFERENCES task_checks(id),CHECK((attempt_id IS NOT NULL AND task_check_id IS NULL) OR (attempt_id IS NULL AND task_check_id IS NOT NULL AND kind IN ('check','read'))),UNIQUE(session_id,worker_epoch,tool_call_id)",
      );
    this.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec(next);
      this.db.exec(`INSERT INTO station_calls_next SELECT *,NULL FROM station_calls;
        DROP TABLE station_calls; ALTER TABLE station_calls_next RENAME TO station_calls;
        CREATE TABLE IF NOT EXISTS agentpod_work(run_key TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),task_id TEXT NOT NULL UNIQUE REFERENCES durable_tasks(id),request_id TEXT NOT NULL UNIQUE,admission_json TEXT NOT NULL,verification_json TEXT NOT NULL);`);
      if (this.db.prepare('PRAGMA foreign_key_check').all().length)
        throw Error('Station ownership migration violates foreign keys');
      this.db.exec('PRAGMA user_version=30; COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON');
    }
  }
  private migrateChildren(): void {
    if (
      (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 4
    )
      return;
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE child_tasks(id TEXT PRIMARY KEY,parent_session TEXT NOT NULL REFERENCES sessions(id),parent_attempt TEXT NOT NULL REFERENCES attempts(id),
        step_key TEXT NOT NULL,input_digest TEXT NOT NULL,child_session TEXT NOT NULL UNIQUE REFERENCES sessions(id),child_attempt TEXT NOT NULL UNIQUE REFERENCES attempts(id),
        authority TEXT NOT NULL,budget INTEGER NOT NULL,state TEXT NOT NULL,result_id TEXT UNIQUE,artifact_id TEXT REFERENCES artifacts(id),acknowledged INTEGER NOT NULL DEFAULT 0,
        UNIQUE(parent_session,step_key));
      CREATE TABLE attempt_budgets(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),limit_requests INTEGER NOT NULL,reserved_requests INTEGER NOT NULL DEFAULT 0,spent_requests INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE usage_observations(source_key TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),attempt_id TEXT REFERENCES attempts(id),provider TEXT NOT NULL,model TEXT NOT NULL,
        status TEXT NOT NULL,input REAL,output REAL,cache_read REAL,cache_write REAL,cost REAL,payload_digest TEXT);
      PRAGMA user_version=4; COMMIT;`);
  }
  transaction<T>(fn: () => T): T {
    if (this.committed) throw new Error('Nested transaction');
    this.db.exec('BEGIN IMMEDIATE');
    this.committed = [];
    let result: T;
    let events: DurableEvent[];
    try {
      result = fn();
      this.db.exec('COMMIT');
      events = this.committed;
    } catch (error) {
      // SQLITE_FULL can roll the transaction back itself. Preserve its cause.
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.committed = null;
    }
    for (const event of events!) this.changes.emit('event', event);
    return result!;
  }
  writable(): void {
    this.transaction(() => {
      this.db.prepare('UPDATE sessions SET revision=revision WHERE 0').run();
    });
  }
  request<T>(actor: string, id: string, input: unknown, fn: () => T): T {
    try {
      return this.transaction(() => this.requestInTransaction(actor, id, input, fn));
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'task_budget_exhausted') {
        const session = (error as ServiceError & { session_id?: unknown }).session_id;
        if (typeof session === 'string') this.taskBudgetDenied?.(session, error);
      }
      throw error;
    }
  }
  requestInTransaction<T>(actor: string, id: string, input: unknown, fn: () => T): T {
    if (!this.committed || !this.db.isTransaction)
      throw Error('Request admission requires an active journal transaction');
    const hash = digest(input);
    const prior = this.db
      .prepare('SELECT hash,response FROM requests WHERE actor=? AND id=?')
      .get(actor, id) as { hash: string; response: string } | undefined;
    if (prior) {
      if (prior.hash !== hash)
        throw new ServiceError(
          'request_conflict',
          'Request ID was already used with different input',
        );
      return JSON.parse(prior.response) as T;
    }
    const response = fn();
    this.db
      .prepare('INSERT INTO requests VALUES (?,?,?,?)')
      .run(actor, id, hash, JSON.stringify(response));
    return response;
  }
  cachedRequest<T>(actor: string, id: string, input: unknown): T | undefined {
    const prior = this.db
      .prepare('SELECT hash,response FROM requests WHERE actor=? AND id=?')
      .get(actor, id) as { hash: string; response: string } | undefined;
    if (!prior) return undefined;
    if (prior.hash !== digest(input))
      throw new ServiceError(
        'request_conflict',
        'Request ID was already used with different input',
      );
    return JSON.parse(prior.response) as T;
  }
  create(
    cwd: string,
    requestId: string,
    coding = false,
    local?: {
      workspace: true;
      route: ProviderRoute;
      requestedRoute?: ProviderRoute;
      outputCap?: boolean;
      coding?: boolean;
    },
  ): Session {
    return this.request(
      'local-operator',
      requestId,
      {
        kind: 'create',
        cwd,
        ...(coding ? { coding: true } : {}),
        ...(local
          ? {
              local: {
                workspace: true,
                route: local.requestedRoute ?? local.route,
                ...(local.coding ? { coding: true } : {}),
              },
            }
          : {}),
      },
      () => {
        const id = randomUUID();
        this.db
          .prepare('INSERT INTO sessions(id,cwd,pi_session_id) VALUES (?,?,?)')
          .run(id, cwd, id);
        this.event(
          id,
          'session.created',
          {
            cwd,
            ...(local
              ? {
                  local_workspace: true,
                  local_coding: local.coding === true,
                  output_cap: local.outputCap ?? true,
                }
              : {}),
          },
          requestId,
        );
        if (local) {
          this.db
            .prepare('INSERT INTO session_routes VALUES (?,?)')
            .run(id, canonical(local.route));
          this.event(id, 'provider.bound', { route: local.route });
        }
        return this.session(id);
      },
    );
  }
  localCoding(id: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM events WHERE session_id=? AND kind='session.created' AND json_extract(payload,'$.local_coding')=1",
      )
      .get(id);
  }
  localWorkspace(id: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM events WHERE session_id=? AND kind='session.created' AND json_extract(payload,'$.local_workspace')=1",
      )
      .get(id);
  }
  localOutputCap(id: string): boolean | undefined {
    const row = this.db
      .prepare(
        "SELECT json_extract(payload,'$.output_cap') AS cap FROM events WHERE session_id=? AND kind='session.created' AND json_extract(payload,'$.local_workspace')=1",
      )
      .get(id);
    return row ? row.cap === 1 : undefined;
  }
  session(id: string): Session {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as
      (Omit<Session, 'capabilities'> & { capabilities: string }) | undefined;
    if (!row) throw new ServiceError('not_found', 'Session not found', 404);
    return { ...row, capabilities: JSON.parse(row.capabilities) };
  }
  forkLocal(
    id: string,
    request: string,
    expected: number,
    controller: Controller,
    clone: (source: Session, target: string) => string,
  ): Session {
    return this.request('local-operator', request, { kind: 'fork', id, expected }, () => {
      this.authorizeControl(id, controller);
      const source = this.session(id);
      if (source.revision !== expected)
        throw new ServiceError('revision_conflict', 'Session changed before fork');
      if (!this.localWorkspace(id) || !source.pi_session_file || this.hasUnknown(id))
        throw new ServiceError(
          'fork_unavailable',
          'Fork requires an initialized local session without uncertain effects',
        );
      if (
        this.db
          .prepare(
            "SELECT 1 FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running')",
          )
          .get(id)
      )
        throw new ServiceError('session_busy', 'Wait for queued and active work before forking');
      this.execution.assert(id);
      const target = randomUUID();
      const file = clone(source, target);
      this.db
        .prepare(
          'INSERT INTO sessions(id,cwd,pi_session_id,pi_session_file,pi_cursor,pi_leaf) VALUES(?,?,?,?,?,?)',
        )
        .run(target, source.cwd, target, file, source.pi_cursor, source.pi_leaf);
      this.event(
        target,
        'session.created',
        {
          cwd: source.cwd,
          local_workspace: true,
          local_coding: this.localCoding(id),
          output_cap: this.localOutputCap(id) ?? true,
          forked_from: id,
        },
        request,
      );
      const route = this.providerRoute(id)!;
      this.db.prepare('INSERT INTO session_routes VALUES (?,?)').run(target, canonical(route));
      this.event(target, 'provider.bound', { route });
      this.db
        .prepare(
          'INSERT INTO pi_entries SELECT ?,entry_id,payload FROM pi_entries WHERE session_id=?',
        )
        .run(target, id);
      this.event(
        target,
        'session.forked',
        { parent: id, parent_revision: expected, leaf: source.pi_leaf, cursor: source.pi_cursor },
        request,
      );
      return this.session(target);
    });
  }
  sessionName(id: string): string | undefined {
    this.session(id);
    const row = this.db
      .prepare(
        "SELECT json_extract(payload,'$.name') AS name FROM events WHERE session_id=? AND kind='session.named' ORDER BY seq DESC LIMIT 1",
      )
      .get(id) as { name: string } | undefined;
    return row?.name;
  }
  nameSession(id: string, request: string, name: string, controller: Controller): { name: string } {
    if (!name.trim() || name.length > 120 || /[\x00-\x1f\x7f]/.test(name))
      throw new ServiceError('invalid_name', 'Use 1–120 printable characters');
    return this.request('local-operator', request, { kind: 'name', id, name }, () => {
      this.authorizeControl(id, controller);
      this.event(id, 'session.named', { name }, request);
      return { name };
    });
  }
  sessions(): Session[] {
    return (
      this.db.prepare('SELECT id FROM sessions ORDER BY rowid').all() as { id: string }[]
    ).map((x) => this.session(x.id));
  }
  event(id: string, kind: string, payload: unknown, cause: string | null = null): DurableEvent {
    if (!this.committed) throw new Error('Event must be part of a transaction');
    this.db.prepare('UPDATE sessions SET seq=seq+1,revision=revision+1 WHERE id=?').run(id);
    const seq = this.session(id).seq;
    const event_id = randomUUID();
    this.db
      .prepare('INSERT INTO events VALUES (?,?,?,?,?,?)')
      .run(id, seq, event_id, kind, cause, JSON.stringify(payload));
    const event: DurableEvent = {
      schema_version: 1,
      event_id,
      session_id: id,
      seq,
      kind,
      causation_id: cause,
      payload,
    };
    this.committed.push(event);
    return event;
  }
  events(id: string, after: number, limit = 256): DurableEvent[] {
    this.session(id);
    return (
      this.db
        .prepare('SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
        .all(id, after, limit) as {
        id: string;
        seq: number;
        kind: string;
        causation_id: string | null;
        payload: string;
      }[]
    ).map((row) => ({
      schema_version: 1,
      event_id: row.id,
      session_id: id,
      seq: row.seq,
      kind: row.kind,
      causation_id: row.causation_id,
      payload: JSON.parse(row.payload),
    }));
  }
  bindRoute(id: string, route: ProviderRoute): void {
    this.transaction(() => {
      const prior = this.db
        .prepare('SELECT route FROM session_routes WHERE session_id=?')
        .get(id) as { route: string } | undefined;
      const expected =
        prior?.route ?? (this.session(id).epoch > 0 ? canonical(OFFLINE_ROUTE) : null);
      if (expected && expected !== canonical(route))
        throw new ServiceError(
          'provider_route_changed',
          'Session provider route differs; restart with its original route or create a new session',
        );
      if (!prior) {
        this.db.prepare('INSERT INTO session_routes VALUES (?,?)').run(id, canonical(route));
        this.event(id, 'provider.bound', { route });
      }
    });
  }
  providerRoute(id: string): ProviderRoute | null {
    const row = this.db.prepare('SELECT route FROM session_routes WHERE session_id=?').get(id) as
      { route: string } | undefined;
    return row ? JSON.parse(row.route) : null;
  }
  allocate(id: string, bootId: string): number {
    return this.transaction(() => {
      this.execution.assert(id);
      const old = this.session(id);
      if (['starting', 'ready'].includes(old.state))
        throw new ServiceError('worker_exists', 'Worker already active');
      const epoch = old.epoch + 1;
      this.db
        .prepare(
          "UPDATE sessions SET epoch=?,state='starting',error=NULL,capabilities='[]' WHERE id=?",
        )
        .run(epoch, id);
      this.db
        .prepare("INSERT INTO workers(session_id,epoch,boot_id,state) VALUES (?,?,?,'starting')")
        .run(id, epoch, bootId);
      this.event(id, 'worker.starting', { epoch });
      return epoch;
    });
  }
  process(id: string, epoch: number, pid: number, identity: string): void {
    this.transaction(() => {
      this.assertEpoch(id, epoch);
      this.db
        .prepare('UPDATE workers SET pid=?,identity=? WHERE session_id=? AND epoch=?')
        .run(pid, identity, id, epoch);
    });
  }
  assertEpoch(id: string, epoch: number): Session {
    const session = this.session(id);
    if (session.epoch !== epoch)
      throw new ServiceError('stale_worker', 'Worker epoch is no longer current');
    return session;
  }
  state(
    id: string,
    epoch: number,
    state: WorkerState,
    error: string | null = null,
    capabilities: string[] = [],
    piFile?: string,
  ): void {
    this.transaction(() => {
      this.assertEpoch(id, epoch);
      this.db
        .prepare(
          'UPDATE sessions SET state=?,error=?,capabilities=?,pi_session_file=COALESCE(?,pi_session_file) WHERE id=?',
        )
        .run(state, error, JSON.stringify(capabilities), piFile ?? null, id);
      this.db
        .prepare('UPDATE workers SET state=? WHERE session_id=? AND epoch=?')
        .run(state, id, epoch);
      this.event(id, `worker.${state}`, { epoch, error, capabilities });
    });
  }
  accept(
    id: string,
    requestId: string,
    expectedRevision: number,
    text: string,
    controller?: Controller,
    continuesAttempt: string | null = null,
  ): { id: string; attempt_id: string; state: 'accepted' } {
    return this.request(
      'local-operator',
      requestId,
      {
        kind: 'submit',
        session: id,
        expectedRevision,
        text,
        ...(continuesAttempt ? { continuesAttempt } : {}),
      },
      () => {
        if (controller) this.authorizeControl(id, controller);
        if (this.session(id).revision !== expectedRevision)
          throw new ServiceError('revision_conflict', 'Session revision changed');
        return this.enqueue(id, requestId, text, controller, continuesAttempt);
      },
    );
  }
  /** Only inside a request transaction: acceptance and its task binding commit together. */
  enqueue(
    id: string,
    requestId: string,
    text: string,
    controller?: Controller,
    continuesAttempt: string | null = null,
    taskStep?: string,
  ): { id: string; attempt_id: string; state: 'accepted' } {
    if (!this.db.isTransaction) throw new Error('Submission requires a transaction');
    if (
      this.db
        .prepare('SELECT 1 FROM turn_cancellations WHERE session_id=? AND target_request_id=?')
        .get(id, requestId)
    )
      throw new ServiceError(
        'prompt_cancelled',
        'This logical instruction was cancelled before dispatch',
      );
    this.execution.assert(id);
    this.guardTaskSubmission?.(id, taskStep);
    if (controller) this.authorizeControl(id, controller);
    if (text.trimStart().startsWith('/'))
      throw new ServiceError(
        'reserved_command',
        'Pi slash commands cannot be submitted as prompts',
        400,
      );
    if (continuesAttempt) {
      const previous = this.db
        .prepare('SELECT * FROM attempts WHERE id=?')
        .get(continuesAttempt) as unknown as Attempt | undefined;
      if (
        !previous ||
        previous.session_id !== id ||
        previous.state !== 'interrupted' ||
        previous.resolved_by
      )
        throw new ServiceError('invalid_continuation', 'Attempt is not an unresolved interruption');
    }
    const submission = randomUUID();
    const attempt = randomUUID();
    this.db
      .prepare('INSERT INTO submissions(id,session_id,text,attempt_id) VALUES (?,?,?,?)')
      .run(submission, id, text, attempt);
    this.db
      .prepare(
        "INSERT INTO attempts(id,session_id,submission_id,state,continues_attempt_id) VALUES (?,?,?,'accepted',?)",
      )
      .run(attempt, id, submission, continuesAttempt);
    if (continuesAttempt)
      this.db
        .prepare('UPDATE attempts SET resolved_by=? WHERE id=?')
        .run(attempt, continuesAttempt);
    this.event(
      id,
      'submission.accepted',
      {
        submission_id: submission,
        attempt_id: attempt,
        continues_attempt_id: continuesAttempt,
      },
      requestId,
    );
    return { id: submission, attempt_id: attempt, state: 'accepted' };
  }
  controlView(id: string): ControlView {
    this.session(id);
    return (
      (this.db
        .prepare('SELECT client_id,epoch,expires_at FROM controls WHERE session_id=?')
        .get(id) as unknown as ControlView | undefined) ?? {
        client_id: null,
        epoch: 0,
        expires_at: 0,
      }
    );
  }
  authorizeControl(id: string, controller: Controller): void {
    const row = this.db
      .prepare('SELECT client_id,token_hash,expires_at FROM controls WHERE session_id=?')
      .get(id) as { client_id: string; token_hash: string; expires_at: number } | undefined;
    if (
      !row ||
      row.client_id !== controller.client_id ||
      row.token_hash !== textDigest(controller.token) ||
      row.expires_at <= Date.now()
    )
      throw new ServiceError('control_required', 'A current controller lease is required');
  }
  control(
    id: string,
    requestId: string,
    client: string,
    action: 'acquire' | 'renew' | 'release' | 'takeover',
    expectedEpoch: number,
    token?: string,
    ttl = 15000,
  ): ControlLease {
    return this.request(
      'local-operator',
      requestId,
      { kind: 'control', session: id, client, action, expectedEpoch },
      () => {
        const old = this.controlView(id);
        if (old.epoch !== expectedEpoch)
          throw new ServiceError('control_conflict', 'Controller epoch changed');
        if (action === 'renew' || action === 'release')
          this.authorizeControl(id, { client_id: client, token: token ?? '' });
        if (action === 'acquire' && old.expires_at > Date.now())
          throw new ServiceError('control_busy', 'Another terminal controls this session');
        const epoch = action === 'renew' ? old.epoch : old.epoch + 1;
        const nextToken = action === 'renew' ? token! : randomBytes(32).toString('hex');
        const expires = action === 'release' ? 0 : Date.now() + ttl;
        this.db
          .prepare(
            `INSERT INTO controls VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
        client_id=excluded.client_id,token_hash=excluded.token_hash,epoch=excluded.epoch,expires_at=excluded.expires_at`,
          )
          .run(id, action === 'release' ? null : client, textDigest(nextToken), epoch, expires);
        this.event(
          id,
          `control.${action}`,
          { client_id: action === 'release' ? null : client, epoch, expires_at: expires },
          requestId,
        );
        return {
          client_id: action === 'release' ? null : client,
          epoch,
          token: nextToken,
          expires_at: expires,
        };
      },
    );
  }
  attempt(id: string): Attempt {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id) as unknown as
      Attempt | undefined;
    if (!row) throw new ServiceError('not_found', 'Attempt not found', 404);
    return {
      ...row,
      outcome: row.outcome ? (JSON.parse(String(row.outcome)) as AttemptOutcome) : null,
    };
  }
  toolMetadata(id: string, call: string): { kind: string; locations: unknown[] } | null {
    this.session(id);
    const row = this.db
      .prepare(
        "SELECT payload FROM events WHERE session_id=? AND kind='tool.started' AND json_extract(payload,'$.tool_call_id')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(id, call);
    if (!row) return null;
    const payload = JSON.parse(String(row.payload));
    return typeof payload.kind === 'string'
      ? { kind: payload.kind, locations: Array.isArray(payload.locations) ? payload.locations : [] }
      : null;
  }
  claim(id: string, epoch: number): { attempt: Attempt; submission: Submission } | null {
    return this.transaction(() => {
      if (this.execution.revocation(id)) return null;
      if (this.assertEpoch(id, epoch).state !== 'ready') return null;
      if (this.hasUnknown(id)) return null;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM attempts WHERE session_id=? AND (state IN ('dispatching','running') OR (state='interrupted' AND resolved_by IS NULL))",
          )
          .get(id)
      )
        return null;
      const next = this.db
        .prepare(
          "SELECT * FROM attempts WHERE session_id=? AND state='accepted' ORDER BY (continues_attempt_id IS NULL),rowid LIMIT 1",
        )
        .get(id) as unknown as Attempt | undefined;
      if (!next) return null;
      this.db
        .prepare("UPDATE attempts SET state='dispatching',worker_epoch=? WHERE id=?")
        .run(epoch, next.id);
      this.db
        .prepare("UPDATE submissions SET state='dispatching' WHERE id=?")
        .run(next.submission_id);
      this.projectTaskAttempt?.(this.attempt(next.id));
      this.event(id, 'attempt.dispatching', {
        attempt_id: next.id,
        submission_id: next.submission_id,
        epoch,
      });
      return {
        attempt: this.attempt(next.id),
        submission: this.db
          .prepare('SELECT * FROM submissions WHERE id=?')
          .get(next.submission_id) as unknown as Submission,
      };
    });
  }
  running(id: string): void {
    this.transaction(() => {
      const attempt = this.attempt(id);
      if (attempt.state !== 'dispatching') return;
      this.db.prepare("UPDATE attempts SET state='running' WHERE id=?").run(id);
      this.db
        .prepare("UPDATE submissions SET state='running' WHERE id=?")
        .run(attempt.submission_id);
      this.projectTaskAttempt?.(this.attempt(id));
      this.event(attempt.session_id, 'attempt.running', {
        attempt_id: id,
        submission_id: attempt.submission_id,
      });
    });
  }
  finish(
    id: string,
    state: 'completed' | 'failed' | 'interrupted' | 'cancelled',
    result: string | null,
    error: string | null,
    transcript?: { epoch: number; entries: { id: string }[]; leaf: string | null },
    outcome?: AttemptOutcome,
  ): void {
    this.transaction(() => {
      const attempt = this.attempt(id);
      if (!['dispatching', 'running'].includes(attempt.state)) return;
      if (state === 'completed' && outcome && outcome.stopReason !== 'end_turn') state = 'failed';
      if (this.cancelled(id)) state = 'cancelled';
      else if (this.hasUnknown(attempt.session_id)) {
        state = 'interrupted';
        error = 'Managed operation outcome is unknown';
      }
      if (transcript)
        this.appendEntries(
          attempt.session_id,
          transcript.epoch,
          transcript.entries,
          transcript.leaf,
        );
      const finalOutcome: AttemptOutcome =
        state === 'completed'
          ? (outcome ?? { version: 1, stopReason: 'end_turn' })
          : state === 'cancelled'
            ? {
                version: 1,
                stopReason: 'cancelled',
                failure: acpFailure(new ServiceError('attempt_cancelled', 'Attempt cancelled')),
              }
            : state === 'interrupted'
              ? {
                  version: 1,
                  stopReason: 'interrupted',
                  failure: acpFailure(
                    new ServiceError('attempt_interrupted', error ?? 'Attempt interrupted'),
                  ),
                }
              : (outcome ?? {
                  version: 1,
                  stopReason: 'error',
                  failure: acpFailure(
                    new ServiceError('attempt_failed', error ?? 'Attempt failed'),
                  ),
                });
      if (finalOutcome.failure)
        finalOutcome.failure = {
          ...finalOutcome.failure,
          sessionId: attempt.session_id,
          attemptId: id,
        };
      this.db
        .prepare('UPDATE attempts SET state=?,result=?,error=?,outcome=? WHERE id=?')
        .run(state, result, error, JSON.stringify(finalOutcome), id);
      this.db
        .prepare('UPDATE submissions SET state=? WHERE id=?')
        .run(state, attempt.submission_id);
      this.event(attempt.session_id, `attempt.${state}`, {
        attempt_id: id,
        submission_id: attempt.submission_id,
        text: result?.slice(0, 65536) ?? null,
        truncated: (result?.length ?? 0) > 65536,
        error,
        outcome: finalOutcome,
      });
      this.projectTaskAttempt?.(this.attempt(id));
      this.finishChild?.(this.attempt(id));
      this.taskChildFinished?.(id);
    });
  }
  recoverWork(): void {
    const active = this.db
      .prepare("SELECT id FROM attempts WHERE state IN ('dispatching','running')")
      .all() as { id: string }[];
    for (const attempt of active)
      this.finish(
        attempt.id,
        'interrupted',
        null,
        'Service stopped before the attempt outcome committed; it will not be replayed',
      );
    this.transaction(() => {
      for (const row of this.db
        .prepare('SELECT session_id FROM controls WHERE expires_at>0')
        .all() as { session_id: string }[]) {
        this.db
          .prepare(
            'UPDATE controls SET client_id=NULL,token_hash=NULL,expires_at=0,epoch=epoch+1 WHERE session_id=?',
          )
          .run(row.session_id);
        this.event(row.session_id, 'control.revoked', { reason: 'service restart' });
      }
    });
  }
  snapshot(id: string): SessionSnapshot {
    const session = this.session(id);
    const attempts = this.db
      .prepare(
        "SELECT * FROM attempts WHERE session_id=? ORDER BY (state='interrupted' AND resolved_by IS NULL) DESC,rowid DESC LIMIT 100",
      )
      .all(id) as unknown as Attempt[];
    const submissions = this.db
      .prepare('SELECT * FROM submissions WHERE session_id=? ORDER BY rowid DESC LIMIT 100')
      .all(id) as unknown as Submission[];
    let resultBudget = 65536;
    let inputBudget = 65536;
    let errorBudget = 65536;
    const boundedAttempts = attempts.map((attempt) => {
      const cap = Math.min(resultBudget, 8192);
      const result = attempt.result?.slice(0, cap) ?? null;
      resultBudget -= result?.length ?? 0;
      const error = attempt.error?.slice(0, Math.min(4096, errorBudget)) ?? null;
      errorBudget -= error?.length ?? 0;
      return {
        ...attempt,
        outcome: attempt.outcome ? JSON.parse(String(attempt.outcome)) : null,
        result,
        error,
        result_truncated: (attempt.result?.length ?? 0) > cap,
      };
    });
    const boundedSubmissions = submissions.map((submission) => {
      const cap = Math.min(inputBudget, 8192);
      inputBudget -= Math.min(submission.text.length, cap);
      return {
        ...submission,
        text: submission.text.slice(0, cap),
        text_truncated: submission.text.length > cap,
      };
    });
    let cursor = session.pi_leaf;
    const seen = new Set<string>();
    const lookup = this.db.prepare(
      'SELECT payload FROM pi_entries WHERE session_id=? AND entry_id=?',
    );
    let remaining = 256 * 1024;
    const messages: SessionSnapshot['messages'] = [];
    while (
      cursor &&
      !seen.has(cursor) &&
      seen.size < 10000 &&
      remaining > 0 &&
      messages.length < 100
    ) {
      seen.add(cursor);
      const row = lookup.get(id, cursor) as { payload: string } | undefined;
      if (!row) break;
      const entry = JSON.parse(row.payload);
      cursor = entry.parentId ?? null;
      const message = entry.message;
      if (!message || !['user', 'assistant'].includes(message.role)) continue;
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((part: { type: string }) => part.type === 'text')
              .map((part: { text: string }) => part.text)
              .join('');
      if (!text) continue;
      const cap = Math.min(65536, remaining);
      if (cap <= 0 || messages.length >= 100) break;
      messages.push({
        entry_id: entry.id,
        role: message.role,
        text: text.slice(0, cap),
        truncated: text.length > cap,
      });
      remaining -= Math.min(text.length, cap);
    }
    return {
      ...session,
      ...(this.db.prepare('SELECT id FROM agentpod_admissions WHERE session_id=?').get(id)
        ? {
            agentpod_admission_id: String(
              this.db.prepare('SELECT id FROM agentpod_admissions WHERE session_id=?').get(id)!.id,
            ),
          }
        : {}),
      control: this.controlView(id),
      attempts: boundedAttempts,
      submissions: boundedSubmissions,
      messages: messages.reverse(),
      history_truncated: cursor !== null,
      approvals: this.approvals(id),
      operations: this.operations(id),
      children: (
        this.db
          .prepare('SELECT * FROM child_tasks WHERE parent_session=? ORDER BY rowid DESC LIMIT 100')
          .all(id) as unknown as SessionSnapshot['children']
      ).map((child) => ({
        ...child,
        worker: this.workerBoundary.view(child.id),
      })),
      ...(this.workerBoundary.profiles
        ? { agents: this.workerBoundary.profiles.snapshot(id) }
        : {}),
      ...(this.teamSnapshot ? { team: this.teamSnapshot(id) } : {}),
    };
  }
  cancelled(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM cancellations WHERE attempt_id=?').get(id);
  }
  hasUnknown(id: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM operations WHERE session_id=? AND state='outcome_unknown' UNION ALL SELECT 1 FROM toolkit_calls c WHERE session_id=? AND state='outcome_unknown' AND NOT ${resolvedToolkitCallSql('c')} LIMIT 1`,
      )
      .get(id, id);
  }
  approvals(id: string): Approval[] {
    this.session(id);
    return this.db
      .prepare('SELECT * FROM approvals WHERE session_id=? ORDER BY rowid DESC LIMIT 100')
      .all(id) as unknown as Approval[];
  }
  operations(id: string): Operation[] {
    this.session(id);
    const rows = this.db
      .prepare(
        "SELECT * FROM operations WHERE session_id=? ORDER BY (state='outcome_unknown') DESC,rowid DESC LIMIT 100",
      )
      .all(id) as unknown as Operation[];
    return rows.map((op) => ({
      ...op,
      value: op.value.slice(0, 256),
      value_truncated: op.value.length > 256,
      receipt: null,
      receipt_available: op.receipt !== null,
      error: op.error?.slice(0, 512) ?? null,
      resolution: op.resolution?.slice(0, 512) ?? null,
    }));
  }
  importEntries(id: string, epoch: number, entries: { id: string }[], leaf: string | null): void {
    this.transaction(() => this.appendEntries(id, epoch, entries, leaf));
  }
  private appendEntries(
    id: string,
    epoch: number,
    entries: { id: string }[],
    leaf: string | null,
  ): void {
    this.assertEpoch(id, epoch);
    for (const entry of entries)
      this.db
        .prepare('INSERT OR IGNORE INTO pi_entries VALUES (?,?,?)')
        .run(id, entry.id, JSON.stringify(entry));
    this.usage.importEntries(id, entries);
    this.db
      .prepare('UPDATE sessions SET pi_cursor=COALESCE(?,pi_cursor),pi_leaf=? WHERE id=?')
      .run(entries.at(-1)?.id ?? null, leaf, id);
    this.reconcileCompactions?.(id);
    this.event(id, 'transcript.synced', { entries: entries.length, leaf });
  }
  close(): void {
    this.db.close();
  }
}
