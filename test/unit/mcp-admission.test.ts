import { afterEach, expect, test } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import corpus from '../fixtures/agentpod-mcp-v1.json' with { type: 'json' };
import { mcpProfile, mcpAssignment, mcpAdmissionView } from '../../src/mcp/protocol.js';
import { McpAdmission } from '../../src/mcp/admission.js';
import { digest } from '../../src/core/protocol.js';
import { agentpodBinding } from '../../src/agentpod/protocol.js';

for (const [cases, parse] of [
  [corpus.profiles, mcpProfile],
  [corpus.assignments, mcpAssignment],
  [corpus.admissions, mcpAdmissionView],
] as const)
  for (const sample of cases)
    test(`shared MCP corpus: ${sample.name}`, () => {
      if (sample.accept) expect(parse(sample.value)).toEqual(sample.value);
      else expect(() => parse(sample.value)).toThrow();
    });

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const dir = realpathSync(mkdtempSync('/tmp/smp-'));
  roots.push(dir);
  const workspace = join(dir, 'work');
  mkdirSync(workspace, { mode: 0o700 });
  const binding = agentpodBinding({
    ...corpus.assignments[0]!.value.binding,
    workspace,
    station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
  });
  const { version, organization_id, node_id, station_key } = binding;
  const pins = { version, organization_id, node_id, station_key, workspace };
  const path = join(dir, 'mcp.json'),
    profile = mcpProfile(corpus.profiles[0]!.value);
  writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
  const profileDigest = digest({ profile, pins_digest: digest(pins) });
  const assignment = {
    ...corpus.assignments[0]!.value,
    binding,
    profile_digest: profileDigest,
    servers: corpus.assignments[0]!.value.servers.map((server) => ({
      ...server,
      url: server.url.replace(
        /mcp-managed-v1\/[a-f0-9]{64}\//,
        `mcp-managed-v1/${digest(binding)}/`,
      ),
    })),
  };
  return { dir, workspace, pins, path, profile, binding, profileDigest, assignment };
}

test('a reviewed private profile binds the current authority and exposes only safe fingerprints', () => {
  const f = fixture(),
    admission = new McpAdmission(f.path, f.pins, f.profileDigest);
  const view = admission.accept(f.assignment, f.binding);
  expect(view).toMatchObject({
    version: 1,
    profile_digest: f.profileDigest,
    binding_digest: digest(f.binding),
    credential_generation: 1,
    servers: [{ name: 'superlibrary' }],
  });
  const serialized = JSON.stringify(view);
  expect(serialized).not.toContain('fixture-proxy-key');
  expect(serialized).not.toContain('X-Agentpod');
  expect(serialized).not.toContain('http://');
  expect(view.assignment_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(admission.accept(f.assignment, f.binding)).toEqual(view);
});

test('an ACP declaration or a foreign principal, station, tenant or run cannot admit an assignment', () => {
  const f = fixture(),
    admission = new McpAdmission(f.path, f.pins, f.profileDigest);
  for (const binding of [
    { ...f.binding, principal_id: 'prn_00000000000000000003' },
    { ...f.binding, organization_id: 'org_00000000000000000003' },
    { ...f.binding, occupancy_epoch: f.binding.occupancy_epoch + 1 },
    { ...f.binding, run: { ...f.binding.run, epoch: f.binding.run.epoch + 1 } },
    { ...f.binding, station_id: 'other-station' },
  ])
    expect(() => admission.accept(f.assignment, binding)).toThrow();
  expect(() => admission.accept({ mcpServers: f.assignment.servers }, f.binding)).toThrow();
  expect(() =>
    admission.accept({ ...f.assignment, profile_digest: 'b'.repeat(64) }, f.binding),
  ).toThrow();
  const otherOrigin = {
    ...f.assignment,
    servers: f.assignment.servers.map((s) => ({ ...s, url: s.url.replace('43421', '43422') })),
  };
  expect(() => admission.accept(otherOrigin, f.binding)).toThrow();
});

test('profile bytes, public permissions, workspace overlap, symlinks and oversized input fail closed', () => {
  const f = fixture(),
    admission = new McpAdmission(f.path, f.pins, f.profileDigest);
  writeFileSync(
    f.path,
    JSON.stringify({ ...f.profile, limits: { ...f.profile.limits, timeout_ms: 10001 } }),
  );
  expect(() => admission.accept(f.assignment, f.binding)).toThrow();
  writeFileSync(f.path, JSON.stringify(f.profile));
  chmodSync(f.path, 0o644);
  expect(() => new McpAdmission(f.path, f.pins, f.profileDigest)).toThrow();
  chmodSync(f.path, 0o600);
  const hardlink = join(f.dir, 'hardlink');
  linkSync(f.path, hardlink);
  expect(() => new McpAdmission(f.path, f.pins, f.profileDigest)).toThrow();
  unlinkSync(hardlink);
  const link = join(f.dir, 'link');
  symlinkSync(f.path, link);
  expect(() => new McpAdmission(link, f.pins, f.profileDigest)).toThrow();
  const inside = join(f.workspace, 'config.json');
  writeFileSync(inside, JSON.stringify(f.profile), { mode: 0o600 });
  expect(() => new McpAdmission(inside, f.pins, f.profileDigest)).toThrow();
  writeFileSync(f.path, ' '.repeat(262145));
  expect(() => new McpAdmission(f.path, f.pins, f.profileDigest)).toThrow();
});

test('rotating a proxy key or credential generation changes the private call binding', () => {
  const f = fixture(),
    admission = new McpAdmission(f.path, f.pins, f.profileDigest);
  const first = admission.accept(f.assignment, f.binding);
  const second = admission.accept({ ...f.assignment, credential_generation: 2 }, f.binding);
  expect(first.assignment_digest).not.toBe(second.assignment_digest);
  const rotated = {
    ...f.assignment,
    credential_generation: 3,
    servers: f.assignment.servers.map((s) => ({
      ...s,
      headers: [
        { name: 'X-Agentpod-Proxy-Key', value: 'rotated-fixture-key-never-use-as-a-live-secret' },
      ],
    })),
  };
  expect(admission.accept(rotated, f.binding).assignment_digest).not.toBe(second.assignment_digest);
});

test('a well-formed managed route must bind the fresh authority, not merely pass wire validation', () => {
  const f = fixture(),
    admission = new McpAdmission(f.path, f.pins, f.profileDigest);
  const wrong = {
    ...f.assignment,
    servers: f.assignment.servers.map((server) => ({
      ...server,
      url: server.url.replace(digest(f.binding), 'b'.repeat(64)),
    })),
  };
  expect(mcpAssignment(wrong)).toEqual(wrong);
  expect(() => admission.accept(wrong, f.binding)).toThrow();
});
