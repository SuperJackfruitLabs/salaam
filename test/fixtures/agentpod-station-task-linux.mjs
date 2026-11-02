/** Explicit isolated Linux acceptance: real Pi offline provider + systemd + stationfs.
 * Synthetic private owner, not a deployed Hub/Superpipeline/fleet canary.
 * Controlled loopback-only MCP/provider endpoints in opaque mode; no real credentials.
 * No source mutation outside owned scratch.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SalaamService } from '../../dist/src/service/service.js';
import {
  stationRuntimeFingerprint,
  stationWorkspaceIdentity,
  readStationConfig,
} from '../../dist/src/agentpod/station-config.js';
import { providerRoute } from '../../dist/src/providers/config.js';
import { mcpCatalogDigest, mcpToolDigest } from '../../dist/src/mcp/http.js';
import corpus from './agentpod-mcp-v1.json' with { type: 'json' };
import { digest } from '../../dist/src/core/protocol.js';
import { call as transportCall } from '../../dist/src/core/transport.js';
// Actual 50k-file verification performs bounded native observations; this is not a cached status read.
const call = (socket, path, body) => transportCall(socket, path, body, undefined, 120000);

process.umask(0o077);
if (process.argv[2] === '--child') {
  const dir = process.argv[3],
    config = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'));
  const service = await SalaamService.open({
    stateDir: join(dir, 'state'),
    agentpodConfig: join(dir, 'pins.json'),
    stationConfig: {
      config: join(dir, 'station.json'),
      configuration_digest: config.configuration_digest,
    },
    agentpodWorkProgression: true,
    ...(config.managedMcp
      ? {
          managedMcp: config.managedMcp,
          providerRoute: providerRoute('anthropic', undefined, 1024),
          anthropicApiKey: 'fixture-anthropic-key',
          extensionPath: fileURLToPath(new URL('./claude-extension.mjs', import.meta.url)),
        }
      : {}),
  });
  if (existsSync(join(dir, 'hold-progression'))) await service.taskDriver.close();
  process.stdout.write('ready\n');
  process.once('SIGTERM', () => void service.close());
  await service.closed;
} else {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 0);
  assert.equal(
    process.env.SALAAM_M21_LINUX_ACCEPTANCE,
    '1',
    'Explicit isolated-host acceptance opt-in required',
  );
  assert.equal(process.version, 'v26.7.0');
  const runtime = realpathSync(process.env.SALAAM_STATION_RUNTIME_ROOT || ''),
    binary = realpathSync(process.env.SALAAM_STATION_FILES || ''),
    image = process.env.SALAAM_STATION_RUNTIME_IMAGE;
  assert(/^sha256:[a-f0-9]{64}$/.test(image || ''));
  assert(existsSync('/run/systemd/system'));
  const reports = [],
    root = mkdtempSync('/tmp/sm21-'),
    self = fileURLToPath(import.meta.url);
  const pin = (p) => ({
    path: realpathSync(p),
    sha256: createHash('sha256')
      .update(readFileSync(realpathSync(p)))
      .digest('hex'),
  });
  const until = async (fn, predicate, ms = 120000) => {
    const end = Date.now() + ms;
    do {
      const value = await fn();
      if (predicate(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < end);
    throw Error('Acceptance condition timed out');
  };
  const cases = (process.env.SALAAM_M21_CASES ?? 'success,crash,revoke,expiry').split(',');
  assert(
    cases.length > 0 &&
      new Set(cases).size === cases.length &&
      cases.every((c) => ['success', 'crash', 'revoke', 'expiry', 'opaque'].includes(c)),
  );
  for (const mode of cases) {
    console.error(JSON.stringify({ scenario: mode, phase: 'starting', scratch: root }));
    const dir = join(root, mode),
      workspace = join(dir, 'workspace'),
      state = join(dir, 'state');
    for (const p of [dir, workspace, state, join(dir, 'home')]) mkdirSync(p, { mode: 0o700 });
    writeFileSync(join(workspace, 'app.js'), 'export const answer = 42;\n');
    if (mode === 'success') {
      mkdirSync(join(workspace, 'large'));
      for (let i = 0; i < 50000; i++)
        writeFileSync(join(workspace, 'large', i + '.txt'), 'fixture\n');
    }
    const binding = {
      version: 1,
      organization_id: 'org_00000000000000000001',
      principal_id: 'prn_00000000000000000002',
      node_id: 'node_m21fixture',
      station_id: 'station_' + mode,
      station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
      occupancy_epoch: 1,
      hub_session_id: 'acps_' + mode,
      workspace,
      run: { source: 'superpipeline', id: 'run_' + randomUUID().replaceAll('-', ''), epoch: 1 },
    };
    const { organization_id, node_id, station_key } = binding;
    writeFileSync(
      join(dir, 'pins.json'),
      JSON.stringify({ version: 1, organization_id, node_id, station_key, workspace }),
      { mode: 0o600 },
    );
    const config = {
      version: 1,
      kind: 'linux-systemd-station-v1',
      workspace,
      workspace_identity: stationWorkspaceIdentity(workspace),
      files: pin(binary),
      systemd_run: pin('/usr/bin/systemd-run'),
      systemctl: pin('/usr/bin/systemctl'),
      runtime_root: runtime,
      runtime_fingerprint: stationRuntimeFingerprint(runtime),
      runtime_image_digest: image,
    };
    writeFileSync(join(dir, 'station.json'), JSON.stringify(config), { mode: 0o600 });
    const configuration_digest = digest(readStationConfig(join(dir, 'station.json'), workspace));
    let mcpServer, provider, assignment, managedMcp;
    const effects = [],
      endpointErrors = [];
    if (mode === 'opaque') {
      const tools = [
        {
          name: 'fixture_mutate',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        },
      ];
      const key = corpus.assignments[0].value.servers[0].headers[0].value;
      const endpoint = `/stations/${binding.station_id}/mcp-managed-v1/${digest(binding)}/superlibrary`;
      mcpServer = createServer(
        (req, res) =>
          void (async () => {
            if (req.method === 'DELETE') {
              res.writeHead(405);
              res.end();
              return;
            }
            assert.equal(req.url, endpoint);
            assert.equal(req.headers['x-agentpod-proxy-key'], key);
            let raw = '';
            for await (const chunk of req) raw += chunk;
            const rpc = JSON.parse(raw);
            const reply = (result) => {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
            };
            if (rpc.method === 'initialize')
              reply({
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'controlled-opaque-endpoint', version: '1' },
              });
            else if (rpc.method === 'tools/list') reply({ tools });
            else if (rpc.method === 'tools/call') {
              effects.push(rpc.params);
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              res.write(': effect accepted; result withheld\n\n');
            } else {
              res.writeHead(202);
              res.end();
            }
          })().catch((e) => {
            endpointErrors.push(String(e));
            res.destroy();
          }),
      );
      mcpServer.listen(0, '127.0.0.1');
      await once(mcpServer, 'listening');
      const profile = structuredClone(corpus.profiles[0].value);
      profile.proxy_origin = `http://127.0.0.1:${mcpServer.address().port}`;
      profile.servers[0].catalog_digest = mcpCatalogDigest(tools);
      profile.servers[0].tools = tools.map((t) => ({
        name: t.name,
        schema_digest: mcpToolDigest(t),
        policy: 'approval',
      }));
      const pins = JSON.parse(readFileSync(join(dir, 'pins.json'), 'utf8'));
      managedMcp = {
        config: join(dir, 'mcp.json'),
        profile_digest: digest({ profile, pins_digest: digest(pins) }),
      };
      writeFileSync(managedMcp.config, JSON.stringify(profile), { mode: 0o600 });
      assignment = {
        ...structuredClone(corpus.assignments[0].value),
        binding,
        profile_digest: managedMcp.profile_digest,
      };
      assignment.servers[0].url = profile.proxy_origin + endpoint;
      writeFileSync(join(workspace, 'claude-mode'), 'mcp-mutate');
      provider = spawn(
        process.execPath,
        [fileURLToPath(new URL('./mock-claude.mjs', import.meta.url)), workspace],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      await once(provider.stdout, 'data');
    }
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ configuration_digest, managedMcp }), {
      mode: 0o600,
    });
    if (mode === 'success')
      writeFileSync(join(dir, 'hold-progression'), 'pause before first durable grant dispatch');
    const socket = join(state, 'operator.sock');
    let child,
      db,
      sequence = 0,
      renewTimer,
      renewError;
    const rows = (sql) => db.prepare(sql).all();
    const boot = async () => {
      child = spawn(process.execPath, [self, '--child', dir], {
        env: { PATH: '/usr/bin:/bin', HOME: join(dir, 'home'), LANG: 'C.UTF-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = '';
      child.stderr.on('data', (b) => {
        errors = (errors + b).slice(-12000);
      });
      await until(
        async () => {
          if (child.exitCode !== null) throw Error('Daemon startup failed: ' + errors);
          try {
            return await call(socket, '/v1/health');
          } catch {
            return null;
          }
        },
        (x) => !!x,
      );
      db = new DatabaseSync(join(state, 'journal.sqlite'), { readOnly: true });
    };
    const stop = async (signal = 'SIGTERM') => {
      if (renewTimer) clearInterval(renewTimer);
      renewTimer = undefined;
      db?.close();
      db = undefined;
      if (child && child.exitCode === null && child.signalCode === null) {
        const done = once(child, 'exit');
        child.kill(signal);
        await done;
      }
    };
    const renew = () =>
      call(socket, '/v1/agentpod/renew', {
        binding,
        request_id: randomUUID(),
        lease_sequence: ++sequence,
      });
    try {
      await boot();
      assert.deepEqual(await call(socket, '/v1/agentpod/work-capability', {}), {
        version: 1,
        enabled: true,
      });
      const admitted = await call(socket, '/v1/agentpod/admit', {
        binding,
        request_id: randomUUID(),
      });
      await renew();
      if (assignment) await call(socket, '/v1/agentpod/mcp-assign', { binding, assignment });
      if (mode !== 'expiry')
        renewTimer = setInterval(
          () =>
            void renew().catch((e) => {
              renewError = e;
            }),
          15000,
        );
      const input = {
        instructions: 'Inspect the fixture source and report a brief result.',
        references: [],
        incoming_handoff: null,
      };
      const plan = {
        objective: 'Verify the actual protected fixture workspace',
        constraints: ['Do not edit files'],
        steps: [
          {
            key: 'inspect',
            title: 'Inspect',
            instruction: 'Inspect app.js and report a brief result.',
            depends_on: [],
            checks: ['tests'],
          },
        ],
        acceptance: [
          {
            key: 'tests',
            command: mode === 'success' ? 'test -f app.js' : 'sleep 120; test -f app.js',
            cwd: '.',
          },
        ],
        deliverables: ['app.js'],
        limits: {
          requests: 2,
          runtime_ms: 240000,
          concurrency: 1,
          token_units: 18432,
          input_token_bound: 8192,
          output_token_bound: 1024,
          verification_runs: 2,
        },
      };
      const admission = {
          version: 1,
          request_id: randomUUID(),
          binding,
          work: {
            board_id: 'brd_M21fixture',
            card_id: 'card_M21fixture',
            stage_key: 'inspect',
            input_digest: digest(input),
            plan_digest: digest(plan),
          },
        },
        payload = { admission, input, plan };
      const receipt = await call(socket, '/v1/agentpod/work-admit', payload);
      const progression = {
        binding,
        request_id: randomUUID(),
        work_request_id: admission.request_id,
        max_steps: 1,
        compact: false,
      };
      // RuntimeMaxSec is 30s: begin near lease expiry so authority, not that cap, stops the unit.
      if (mode === 'expiry') await new Promise((r) => setTimeout(r, 65000));
      const grant = await call(socket, '/v1/agentpod/work-progress', progression);
      assert.deepEqual(await call(socket, '/v1/agentpod/work-progress', progression), grant);
      await assert.rejects(
        call(socket, '/v1/agentpod/work-progress', { ...progression, request_id: randomUUID() }),
      );
      const status = () => call(socket, '/v1/agentpod/work-status', { binding });
      if (mode === 'opaque') {
        const offer = await until(
          () => call(socket, '/v1/agentpod/work-decisions', { binding }),
          (x) => x.decisions.length === 1,
        );
        const decision = offer.decisions[0];
        assert.equal(effects.length, 0);
        const answer = {
          version: 1,
          request_id: randomUUID(),
          decision,
          decision_digest: digest(decision),
          elicitation_id: 'elc_fixtureopaque',
          option_id: 'approve',
          answered_by: 'synthetic-private-owner',
          answered_at: new Date().toISOString(),
        };
        await call(socket, '/v1/agentpod/work-decision', { binding, answer });
        await until(
          async () => effects.length,
          (n) => n === 1,
        );
        await stop('SIGKILL');
        await boot();
        await until(
          async () => rows('SELECT * FROM mcp_calls'),
          (calls) => calls.length === 1 && calls[0].state === 'outcome_unknown',
        );
        await assert.rejects(call(socket, '/v1/agentpod/work-completion', { binding }));
        assert.deepEqual(await call(socket, '/v1/agentpod/work-admit', payload), receipt);
        await renew();
        assert.deepEqual(await call(socket, '/v1/agentpod/work-progress', progression), grant);
        await assert.rejects(
          call(socket, '/v1/agentpod/work-progress', { ...progression, request_id: randomUUID() }),
        );
        await new Promise((r) => setTimeout(r, 1000));
        assert.equal(effects.length, 1);
        assert.equal(rows('SELECT * FROM mcp_calls').length, 1);
        assert.equal(rows('SELECT * FROM mcp_calls')[0].state, 'outcome_unknown');
        await assert.rejects(call(socket, '/v1/agentpod/work-completion', { binding }));
        const unknown = rows("SELECT id FROM operations WHERE state='outcome_unknown'");
        assert.equal(unknown.length, 1);
        const attempts = rows('SELECT id FROM attempts');
        await stop();
        await boot();
        await renew();
        await assert.rejects(call(socket, '/v1/agentpod/work-completion', { binding }));
        assert.deepEqual(await call(socket, '/v1/agentpod/work-progress', progression), grant);
        await new Promise((r) => setTimeout(r, 1000));
        assert.deepEqual(rows("SELECT id FROM operations WHERE state='outcome_unknown'"), unknown);
        assert.deepEqual(rows('SELECT id FROM attempts'), attempts);
        assert.equal(effects.length, 1);
        assert.deepEqual(endpointErrors, []);
        reports.push({
          mode,
          session_id: admitted.session_id,
          task_id: receipt.task_id,
          effects: 1,
          call_state: 'outcome_unknown',
          completion_rejected: true,
          replacement_grants: 0,
          scope: 'real daemon/Pi/HTTP/ledger; controlled synthetic external endpoint and provider',
        });
      } else if (mode === 'success') {
        assert.equal(rows('SELECT COUNT(*) AS n FROM attempts')[0].n, 0);
        await stop('SIGKILL');
        unlinkSync(join(dir, 'hold-progression'));
        await boot();
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(rows('SELECT COUNT(*) AS n FROM attempts')[0].n, 0);
        assert.equal(rows('SELECT auto_enabled FROM task_runtime')[0].auto_enabled, 1);
        await renew();
        renewTimer = setInterval(
          () =>
            void renew().catch((e) => {
              renewError = e;
            }),
          15000,
        );
        assert.deepEqual(await call(socket, '/v1/agentpod/work-progress', progression), grant);

        await until(
          status,
          (s) => {
            if (
              ['failed', 'cancelled'].includes(s.state) ||
              (s.state === 'blocked' && !s.auto_enabled)
            )
              throw Error('Progression failed: ' + s.reason);
            return s.state === 'succeeded';
          },
          240000,
        );
        console.error(JSON.stringify({ scenario: mode, phase: 'task-succeeded' }));
        const completion = await call(socket, '/v1/agentpod/work-completion', { binding });
        assert.equal(completion.state, 'verified');
        const before = rows('SELECT id FROM task_checks'),
          attempts = rows('SELECT id FROM attempts');
        assert.equal(before.length, 2);
        assert.equal(rows('SELECT verification_runs FROM task_runtime')[0].verification_runs, 2);
        assert(
          rows("SELECT * FROM station_calls WHERE kind='check'").every(
            (c) => c.attempt_id === null && c.task_check_id && c.state === 'returned',
          ),
        );
        assert(rows('SELECT * FROM station_units').every((u) => u.state === 'stopped'));
        await stop();
        await boot();
        await renew();
        assert.deepEqual(await call(socket, '/v1/agentpod/work-admit', payload), receipt);
        assert.deepEqual(await call(socket, '/v1/agentpod/work-progress', progression), grant);
        assert.deepEqual(
          await call(socket, '/v1/agentpod/work-completion', { binding }),
          completion,
        );
        assert.deepEqual(rows('SELECT id FROM task_checks'), before);
        assert.deepEqual(rows('SELECT id FROM attempts'), attempts);
        writeFileSync(join(workspace, 'app.js'), 'export const answer = 43;\n');
        await assert.rejects(call(socket, '/v1/agentpod/work-completion', { binding }));
        console.error(JSON.stringify({ scenario: mode, phase: 'passed' }));
        reports.push({
          mode,
          session_id: admitted.session_id,
          task_id: receipt.task_id,
          completion,
          native_checks: before.length,
          large_files: 50000,
          restart_dedup: true,
          changed_tree_rejected: true,
        });
      } else {
        const unit = await until(
          async () => rows("SELECT * FROM station_units WHERE state='running'")[0],
          (x) => !!x,
        );
        const originalCalls = rows("SELECT id FROM station_calls WHERE kind='check'");
        if (mode === 'crash') {
          await stop('SIGKILL');
          await boot();
        }
        if (mode === 'revoke')
          await call(socket, '/v1/agentpod/revoke', {
            binding,
            request_id: randomUUID(),
            reason: 'isolated M21 revocation proof',
          });
        if (renewTimer) clearInterval(renewTimer);
        renewTimer = undefined;
        await until(
          async () => rows('SELECT * FROM station_units').find((u) => u.id === unit.id),
          (u) => u?.state === 'stopped',
          120000,
        );
        if (mode === 'expiry') {
          const expired = await until(
            () => call(socket, '/v1/agentpod/status', { binding }),
            (s) => s.revoked === true,
            35000,
          );
          assert(expired.expires_at <= Date.now());
          assert.equal(expired.authorized, false);
        }
        const callRow = rows('SELECT * FROM station_calls').find((c) => c.id === unit.call_id);
        assert.notEqual(callRow.state, 'returned');
        assert.deepEqual(rows("SELECT id FROM station_calls WHERE kind='check'"), originalCalls);
        await assert.rejects(call(socket, '/v1/agentpod/work-completion', { binding }));
        assert.deepEqual(await call(socket, '/v1/agentpod/work-admit', payload), receipt);
        console.error(JSON.stringify({ scenario: mode, phase: 'passed' }));
        reports.push({
          mode,
          session_id: admitted.session_id,
          task_id: receipt.task_id,
          unit: unit.id,
          stopped: true,
          call_state: callRow.state,
          replacement_checks: 0,
          completion_rejected: true,
        });
      }
      if (renewError && mode === 'success') throw renewError;
    } finally {
      await stop();
      if (provider && provider.exitCode === null) {
        const done = once(provider, 'exit');
        provider.kill('SIGKILL');
        await done;
      }
      if (mcpServer) {
        mcpServer.closeAllConnections();
        await new Promise((r) => mcpServer.close(r));
      }
    }
  }
  const evidence = {
    version: 1,
    success: true,
    scope:
      'isolated Linux real daemon/Pi/systemd/stationfs; controlled fixture provider and private authority, not live product acceptance',
    scratch: root,
    runtime_image_digest: image,
    reports,
  };
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify(evidence));
}
