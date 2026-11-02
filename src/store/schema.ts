// The state database's schema: the tables each version adds, in the order the versions came, and
// the startup-only station migration. The DDL is the schema; it never changes after release.
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ServiceError } from '../core/index.js';

/** The newest schema this service understands; a newer database is refused. */
const NEWEST_SCHEMA = 31;

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** Bring a just-opened database to the current schema, closing it on failure. The worker
 * boundary's own tables are version 12. */
export function migrate(db: DatabaseSync, migrateWorkerBoundary: () => void): void {
  const version = userVersion(db);
  if (version > NEWEST_SCHEMA) {
    db.close();
    throw new ServiceError('schema_too_new', 'Database schema is newer than this service');
  }
  if (version === 0)
    db.exec(`BEGIN IMMEDIATE;
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
      db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE submissions ADD COLUMN attempt_id TEXT;
        CREATE TABLE attempts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
          submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id), state TEXT NOT NULL,
          worker_epoch INTEGER, error TEXT, result TEXT, continues_attempt_id TEXT REFERENCES attempts(id), resolved_by TEXT);
        CREATE INDEX attempt_queue ON attempts(session_id,state);
        CREATE TABLE controls (session_id TEXT PRIMARY KEY REFERENCES sessions(id), client_id TEXT, token_hash TEXT,
          epoch INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0);`);
      for (const row of db.prepare('SELECT id,session_id FROM submissions').all() as {
        id: string;
        session_id: string;
      }[]) {
        const attempt = randomUUID();
        db.prepare(
          "INSERT INTO attempts(id,session_id,submission_id,state) VALUES (?,?,?,'accepted')",
        ).run(attempt, row.session_id, row.id);
        db.prepare('UPDATE submissions SET attempt_id=? WHERE id=?').run(attempt, row.id);
      }
      db.exec('PRAGMA user_version=2; COMMIT;');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  if (version < 3) {
    try {
      db.exec(`BEGIN IMMEDIATE;
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
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  try {
    migrateChildren(db);
    if (userVersion(db) < 5)
      db.exec(
        `BEGIN IMMEDIATE; CREATE TABLE session_routes(session_id TEXT PRIMARY KEY REFERENCES sessions(id),route TEXT NOT NULL); PRAGMA user_version=5; COMMIT;`,
      );
    if (userVersion(db) < 6)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE task_heads(session_id TEXT PRIMARY KEY REFERENCES sessions(id),version INTEGER NOT NULL DEFAULT 0,compaction_cursor TEXT);
          CREATE TABLE task_facts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),version INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,
            supersedes TEXT UNIQUE REFERENCES task_facts(id),artifact_id TEXT REFERENCES artifacts(id),source TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(session_id,version));
          CREATE TABLE compactions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),epoch INTEGER NOT NULL,task_version INTEGER NOT NULL,state TEXT NOT NULL,cursor TEXT,error TEXT);
          CREATE TABLE compaction_cancellations(id TEXT PRIMARY KEY REFERENCES compactions(id));
          PRAGMA user_version=6;COMMIT;`);
    if (userVersion(db) < 7)
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),source TEXT NOT NULL,root TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,baseline TEXT NOT NULL REFERENCES artifacts(id),state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspace_mutations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),request_key TEXT NOT NULL,input_digest TEXT NOT NULL,expected_revision INTEGER NOT NULL,before_digest TEXT NOT NULL,after_digest TEXT NOT NULL,artifact_id TEXT NOT NULL REFERENCES artifacts(id),before_root TEXT NOT NULL,after_root TEXT NOT NULL,state TEXT NOT NULL,error TEXT,UNIQUE(workspace_id,request_key));
        CREATE TABLE IF NOT EXISTS command_runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),attempt_id TEXT REFERENCES attempts(id),step_key TEXT NOT NULL,input_digest TEXT NOT NULL,command TEXT NOT NULL,cwd TEXT NOT NULL,workspace_revision INTEGER NOT NULL,workspace_digest TEXT NOT NULL,profile_digest TEXT NOT NULL,engine_id TEXT NOT NULL,snapshot_artifact TEXT NOT NULL REFERENCES artifacts(id),container_id TEXT,exec_id TEXT,state TEXT NOT NULL,resume_state TEXT,exit_code INTEGER,output TEXT NOT NULL DEFAULT '',result_artifact TEXT,error TEXT,created_at INTEGER NOT NULL,deadline INTEGER NOT NULL,cancelled INTEGER NOT NULL DEFAULT 0,UNIQUE(session_id,step_key));
        PRAGMA user_version=7; COMMIT;`);
    if (userVersion(db) < 8)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE durable_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),revision INTEGER NOT NULL,plan_revision INTEGER NOT NULL,state TEXT NOT NULL,objective TEXT NOT NULL,constraints_json TEXT NOT NULL,reason TEXT NOT NULL);
          CREATE TABLE task_plans(task_id TEXT NOT NULL REFERENCES durable_tasks(id),revision INTEGER NOT NULL,document TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(task_id,revision));
          CREATE TABLE task_steps(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES durable_tasks(id),step_key TEXT NOT NULL,ordinal INTEGER NOT NULL,title TEXT NOT NULL,instruction TEXT NOT NULL,dependencies TEXT NOT NULL,state TEXT NOT NULL,attempt_id TEXT REFERENCES attempts(id),review TEXT,UNIQUE(task_id,step_key),UNIQUE(task_id,ordinal));
          CREATE TABLE task_step_attempts(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),step_id TEXT NOT NULL REFERENCES task_steps(id),plan_revision INTEGER NOT NULL,instruction TEXT NOT NULL);
          PRAGMA user_version=8; COMMIT;`);
    if (userVersion(db) < 9)
      db.exec(`BEGIN IMMEDIATE;
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
    if (userVersion(db) < 10)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE jobs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES durable_tasks(id),session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),name TEXT NOT NULL,revision INTEGER NOT NULL,binding TEXT NOT NULL,binding_digest TEXT NOT NULL,max_steps INTEGER NOT NULL,compact INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
          CREATE TABLE job_occurrences(id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),occurrence_key TEXT NOT NULL,binding_digest TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
          PRAGMA user_version=10; COMMIT;`);
    if (userVersion(db) < 11)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE recurring_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),name TEXT NOT NULL,revision INTEGER NOT NULL,template TEXT NOT NULL,template_digest TEXT NOT NULL,state TEXT NOT NULL,next_due INTEGER,created_at INTEGER NOT NULL);
          CREATE TABLE schedule_revisions(job_id TEXT NOT NULL REFERENCES recurring_jobs(id),revision INTEGER NOT NULL,definition TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(job_id,revision));
          CREATE TABLE recurring_occurrences(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES recurring_jobs(id),occurrence_key TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),job_run_id TEXT UNIQUE REFERENCES jobs(id),schedule_revision INTEGER NOT NULL,due_at INTEGER,state TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,UNIQUE(job_id,occurrence_key));
          CREATE TABLE operator_inbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),source_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,detail TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,ack_revision INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
          PRAGMA user_version=11; COMMIT;`);
    if (userVersion(db) < 12) {
      db.exec('BEGIN IMMEDIATE');
      migrateWorkerBoundary();
      db.exec('PRAGMA user_version=12; COMMIT;');
    }
    if (userVersion(db) < 13)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE agent_grants(id TEXT PRIMARY KEY,owner_session TEXT NOT NULL REFERENCES sessions(id),profile_id TEXT NOT NULL,document TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL);
          CREATE TABLE specialist_reports(worker_id TEXT PRIMARY KEY,input_digest TEXT NOT NULL,artifact_id TEXT NOT NULL REFERENCES artifacts(id));
          PRAGMA user_version=13; COMMIT;`);
    if (userVersion(db) < 14)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE team_assignments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES durable_tasks(id),step_id TEXT NOT NULL REFERENCES task_steps(id),plan_revision INTEGER NOT NULL,profile_id TEXT NOT NULL,grant_id TEXT NOT NULL REFERENCES agent_grants(id),budget INTEGER NOT NULL,generation INTEGER NOT NULL DEFAULT 0,child_id TEXT REFERENCES child_tasks(id),superseded INTEGER NOT NULL DEFAULT 0);
          CREATE UNIQUE INDEX team_active_step ON team_assignments(step_id) WHERE superseded=0;
          CREATE TABLE team_messages(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES durable_tasks(id),sender TEXT NOT NULL,recipient TEXT NOT NULL REFERENCES team_assignments(id),text TEXT NOT NULL,input_digest TEXT NOT NULL,created_at INTEGER NOT NULL,delivered_at INTEGER,acknowledged_at INTEGER);
          PRAGMA user_version=14; COMMIT;`);
    if (userVersion(db) < 15)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE worker_integrations(id TEXT PRIMARY KEY,parent_session TEXT NOT NULL REFERENCES sessions(id),child_id TEXT NOT NULL UNIQUE REFERENCES child_tasks(id),worker_id TEXT NOT NULL,patch_digest TEXT NOT NULL,before_revision INTEGER NOT NULL,before_digest TEXT NOT NULL,after_artifact TEXT NOT NULL REFERENCES artifacts(id),state TEXT NOT NULL,mutation_id TEXT REFERENCES workspace_mutations(id),mutation_key TEXT NOT NULL UNIQUE,generation INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE team_rejections(step_id TEXT NOT NULL REFERENCES task_steps(id),attempt_id TEXT NOT NULL REFERENCES attempts(id),request_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(step_id,attempt_id));
          PRAGMA user_version=15; COMMIT;`);
    if (userVersion(db) < 16)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE external_assignments(assignment_id TEXT PRIMARY KEY REFERENCES team_assignments(id),runtime TEXT NOT NULL,digest TEXT NOT NULL);
          CREATE TABLE external_runs(child_id TEXT PRIMARY KEY REFERENCES child_tasks(id),run_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,epoch INTEGER NOT NULL,checkpoint TEXT,receipt TEXT,stopped INTEGER NOT NULL DEFAULT 0,error TEXT,result TEXT,import_artifact TEXT REFERENCES artifacts(id));
          CREATE TABLE task_invocations(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),task_id TEXT NOT NULL REFERENCES durable_tasks(id),runtime_id TEXT NOT NULL,input_digest TEXT NOT NULL,created_at INTEGER NOT NULL);
          CREATE TABLE external_model_requests(id TEXT PRIMARY KEY,child_id TEXT NOT NULL REFERENCES external_runs(child_id),input_bytes INTEGER NOT NULL,output_bound INTEGER NOT NULL);
          PRAGMA user_version=16; COMMIT;`);
    if (userVersion(db) < 17)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE a2a_inbound(id TEXT PRIMARY KEY,peer TEXT NOT NULL,tenant TEXT NOT NULL,message_id TEXT NOT NULL,input_digest TEXT NOT NULL,assignment_id TEXT NOT NULL UNIQUE REFERENCES team_assignments(id),grant_digest TEXT NOT NULL,context_id TEXT NOT NULL UNIQUE,child_id TEXT NOT NULL UNIQUE REFERENCES child_tasks(id),created_at INTEGER NOT NULL,skill TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,UNIQUE(peer,tenant,message_id));
          PRAGMA user_version=17; COMMIT;`);
    if (userVersion(db) < 18)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE session_revocations(session_id TEXT PRIMARY KEY REFERENCES sessions(id),receipt TEXT NOT NULL);
          PRAGMA user_version=18; COMMIT;`);
    if (userVersion(db) < 19)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE agentpod_admissions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),hub_session_id TEXT NOT NULL UNIQUE,run_key TEXT NOT NULL UNIQUE,binding TEXT NOT NULL,digest TEXT NOT NULL,pins_digest TEXT NOT NULL,lease_sequence INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,boot_id TEXT,monotonic_deadline REAL,state TEXT NOT NULL DEFAULT 'pending');
          CREATE TABLE agentpod_station_epochs(station_id TEXT PRIMARY KEY,occupancy_epoch INTEGER NOT NULL,principal_id TEXT NOT NULL);
          PRAGMA user_version=19; COMMIT;`);
    if (userVersion(db) < 20)
      db.exec(`BEGIN IMMEDIATE;
          ALTER TABLE attempts ADD COLUMN outcome TEXT;
          CREATE TABLE turn_cancellations(request_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),target_request_id TEXT,attempt_ids TEXT NOT NULL,receipt TEXT NOT NULL,requested_at INTEGER NOT NULL);
          CREATE INDEX turn_cancellations_target ON turn_cancellations(session_id,target_request_id);
          PRAGMA user_version=20; COMMIT;`);
    if (userVersion(db) < 21)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE mcp_assignments(session_id TEXT PRIMARY KEY REFERENCES sessions(id),credential_generation INTEGER NOT NULL,assignment_digest TEXT NOT NULL,view TEXT NOT NULL);
          CREATE TABLE mcp_calls(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),worker_epoch INTEGER NOT NULL,attempt_id TEXT NOT NULL REFERENCES attempts(id),tool_call_id TEXT NOT NULL,input_digest TEXT NOT NULL,binding_digest TEXT NOT NULL,profile_digest TEXT NOT NULL,assignment_digest TEXT NOT NULL,credential_generation INTEGER NOT NULL,server_name TEXT NOT NULL,tool_name TEXT NOT NULL,policy TEXT NOT NULL,arguments_json TEXT NOT NULL,operation_id TEXT UNIQUE REFERENCES operations(id),state TEXT NOT NULL,result_artifact TEXT REFERENCES artifacts(id),error TEXT,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,UNIQUE(session_id,worker_epoch,tool_call_id));
          CREATE INDEX mcp_calls_attempt ON mcp_calls(session_id,attempt_id);
          PRAGMA user_version=21; COMMIT;`);
    if (userVersion(db) < 22)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE toolkit_resources(id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),root_digest TEXT NOT NULL,profile_digest TEXT NOT NULL,state_dir TEXT NOT NULL,input_digest TEXT NOT NULL,spec TEXT NOT NULL,owner_boot TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','launching','running','unconfirmed','stopped')),pid INTEGER CHECK(pid IS NULL OR pid>0),identity TEXT,stop_digest TEXT,stop_receipt TEXT,revision INTEGER NOT NULL DEFAULT 0,CHECK(state!='running' OR (pid IS NOT NULL AND identity IS NOT NULL)),CHECK((state='stopped')=(stop_digest IS NOT NULL AND stop_receipt IS NOT NULL)));
          CREATE UNIQUE INDEX toolkit_resources_root_owner ON toolkit_resources(root_digest) WHERE state!='stopped';
          CREATE UNIQUE INDEX toolkit_resources_state_owner ON toolkit_resources(state_dir) WHERE state!='stopped';
          PRAGMA user_version=22; COMMIT;`);
    if (userVersion(db) < 23)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE toolkit_owners(resource_id TEXT PRIMARY KEY NOT NULL REFERENCES toolkit_resources(id),key_digest TEXT NOT NULL UNIQUE CHECK(length(key_digest)=64));
          CREATE TABLE toolkit_calls(id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),worker_epoch INTEGER NOT NULL,attempt_id TEXT NOT NULL REFERENCES attempts(id),tool_call_id TEXT NOT NULL,resource_id TEXT NOT NULL REFERENCES toolkit_resources(id),request_json TEXT NOT NULL,request_digest TEXT NOT NULL,context_digest TEXT NOT NULL,action_pin TEXT NOT NULL,operation_id TEXT UNIQUE REFERENCES operations(id),state TEXT NOT NULL CHECK(state IN ('prepared','delivered','dispatching','pending','denied','returned','outcome_unknown','cancelled')),receipt_json TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),revision INTEGER NOT NULL DEFAULT 1,UNIQUE(session_id,worker_epoch,tool_call_id));
          CREATE INDEX toolkit_calls_resource ON toolkit_calls(resource_id,state);
          CREATE UNIQUE INDEX toolkit_calls_active_resource ON toolkit_calls(resource_id) WHERE state IN ('prepared','delivered','dispatching','pending','outcome_unknown');
          PRAGMA user_version=23; COMMIT;`);
    if (userVersion(db) < 24)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE toolkit_cleanup_profiles(resource_id TEXT PRIMARY KEY NOT NULL REFERENCES toolkit_resources(id),profile_path TEXT NOT NULL,profile_digest TEXT NOT NULL CHECK(length(profile_digest)=64));
          PRAGMA user_version=24; COMMIT;`);
    if (userVersion(db) < 25)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE toolkit_resolutions(id TEXT PRIMARY KEY NOT NULL,request_id TEXT NOT NULL UNIQUE,call_id TEXT NOT NULL UNIQUE REFERENCES toolkit_calls(id),operation_id TEXT UNIQUE REFERENCES operations(id),call_revision INTEGER NOT NULL,request_digest TEXT NOT NULL,context_json TEXT NOT NULL,context_digest TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','native_settled','committed')),native_receipt_json TEXT,revision INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE toolkit_resolution_controls(id TEXT PRIMARY KEY NOT NULL,resolution_id TEXT NOT NULL REFERENCES toolkit_resolutions(id),resource_id TEXT NOT NULL UNIQUE REFERENCES toolkit_resources(id),control_json TEXT NOT NULL,result_json TEXT,state TEXT NOT NULL CHECK(state IN ('prepared','returned','outcome_unknown')));
          PRAGMA user_version=25; COMMIT;`);
    if (userVersion(db) < 26)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE station_calls(id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),worker_epoch INTEGER NOT NULL,attempt_id TEXT NOT NULL REFERENCES attempts(id),tool_call_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('patch','check','read')),input_digest TEXT NOT NULL,root_digest TEXT NOT NULL,configuration_digest TEXT NOT NULL,args_json TEXT NOT NULL,operation_id TEXT UNIQUE REFERENCES operations(id),state TEXT NOT NULL CHECK(state IN ('prepared','dispatching','returned','failed','outcome_unknown','cancelled')),revision INTEGER NOT NULL DEFAULT 1,result_json TEXT,helper_pid INTEGER,helper_identity TEXT,helper_state TEXT NOT NULL DEFAULT 'none',helper_stop_json TEXT,UNIQUE(session_id,worker_epoch,tool_call_id));
          CREATE TABLE station_units(id TEXT PRIMARY KEY NOT NULL,session_id TEXT REFERENCES sessions(id),call_id TEXT UNIQUE REFERENCES station_calls(id),context_digest TEXT NOT NULL,config_json TEXT NOT NULL,snapshot_path TEXT NOT NULL,output_path TEXT NOT NULL,unit_json TEXT,state TEXT NOT NULL CHECK(state IN ('prepared','launching','running','unconfirmed','stopped')),stop_json TEXT);
          PRAGMA user_version=26; COMMIT;`);
    if (userVersion(db) < 27)
      db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE local_calls(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),attempt_id TEXT NOT NULL REFERENCES attempts(id),epoch INTEGER NOT NULL,tool_call TEXT NOT NULL,input_digest TEXT NOT NULL,root TEXT NOT NULL,args TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),state TEXT NOT NULL,result TEXT,pid INTEGER,identity TEXT,UNIQUE(session_id,epoch,tool_call));
          PRAGMA user_version=27; COMMIT;`);
    if (version >= 30) db.prepare('SELECT task_check_id FROM station_calls LIMIT 0').all();
    if (version >= 31)
      db.prepare(
        'SELECT session_id,revision,digest,document FROM context_admissions LIMIT 0',
      ).all();
    // Strict work is a lazy migration: a schema29 database must retain its mapping.
    if (version >= 29)
      db.prepare(
        'SELECT run_key,session_id,task_id,request_id,admission_json,verification_json FROM agentpod_work LIMIT 0',
      ).all();
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}

/** Startup-only migration: verification has task ownership, never a fabricated
 * model attempt. Rebuild with FK checks before commit; rollback retains v29. */
export function enableStationTaskChecks(db: DatabaseSync): void {
  if (db.isTransaction) throw Error('Station schema migration requires an idle journal');
  const version = userVersion(db);
  if (version >= 30) {
    db.prepare('SELECT task_check_id FROM station_calls LIMIT 0').all();
    return;
  }
  const original = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE name='station_calls'").get()!.sql,
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
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(next);
    db.exec(`INSERT INTO station_calls_next SELECT *,NULL FROM station_calls;
        DROP TABLE station_calls; ALTER TABLE station_calls_next RENAME TO station_calls;
        CREATE TABLE IF NOT EXISTS agentpod_work(run_key TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),task_id TEXT NOT NULL UNIQUE REFERENCES durable_tasks(id),request_id TEXT NOT NULL UNIQUE,admission_json TEXT NOT NULL,verification_json TEXT NOT NULL);`);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw Error('Station ownership migration violates foreign keys');
    db.exec('PRAGMA user_version=30; COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
}

function migrateChildren(db: DatabaseSync): void {
  if (userVersion(db) >= 4) return;
  db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE child_tasks(id TEXT PRIMARY KEY,parent_session TEXT NOT NULL REFERENCES sessions(id),parent_attempt TEXT NOT NULL REFERENCES attempts(id),
        step_key TEXT NOT NULL,input_digest TEXT NOT NULL,child_session TEXT NOT NULL UNIQUE REFERENCES sessions(id),child_attempt TEXT NOT NULL UNIQUE REFERENCES attempts(id),
        authority TEXT NOT NULL,budget INTEGER NOT NULL,state TEXT NOT NULL,result_id TEXT UNIQUE,artifact_id TEXT REFERENCES artifacts(id),acknowledged INTEGER NOT NULL DEFAULT 0,
        UNIQUE(parent_session,step_key));
      CREATE TABLE attempt_budgets(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),limit_requests INTEGER NOT NULL,reserved_requests INTEGER NOT NULL DEFAULT 0,spent_requests INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE usage_observations(source_key TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),attempt_id TEXT REFERENCES attempts(id),provider TEXT NOT NULL,model TEXT NOT NULL,
        status TEXT NOT NULL,input REAL,output REAL,cache_read REAL,cache_write REAL,cost REAL,payload_digest TEXT);
      PRAGMA user_version=4; COMMIT;`);
}
