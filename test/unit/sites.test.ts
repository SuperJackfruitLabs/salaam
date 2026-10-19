import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ROOT } from '../../src/config.js';

const { deploymentDecision } = await import(
  pathToFileURL(join(ROOT, 'scripts/site-deploy-target.mjs')).href
);
const { publicFiles, verifyPublicFiles } = await import(
  pathToFileURL(join(ROOT, 'scripts/verify-sites.mjs')).href
);
const repository = 'SuperJackfruitLabs/salaam';
const commit = 'a'.repeat(40);
const run = {
  id: 12,
  head_sha: commit,
  head_branch: 'main',
  event: 'push',
  path: '.github/workflows/ci.yml',
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  status: 'completed',
  conclusion: 'success',
};
const target = {
  eventName: 'workflow_run',
  event: { workflow_run: { id: 12, head_sha: commit } },
  repository,
  commit,
  main: commit,
  run,
};

test('successful exact main CI can deploy; a newer main suppresses stale publication', () => {
  expect(deploymentDecision(target).deploy).toBe(true);
  expect(deploymentDecision({ ...target, main: 'b'.repeat(40) }).deploy).toBe(false);
});
test.each([
  { conclusion: 'failure' },
  { status: 'in_progress' },
  { event: 'pull_request' },
  { head_branch: 'feature' },
  { head_sha: 'b'.repeat(40) },
  { path: '.github/workflows/other.yml' },
  { head_repository: { full_name: 'fork/salaam' } },
  { repository: { full_name: 'fork/salaam' } },
])('rejects CI that cannot authorize production: %j', (change) => {
  expect(() => deploymentDecision({ ...target, run: { ...run, ...change } })).toThrow();
});
test('rejects a different event run and a non-main manual retry', () => {
  expect(() =>
    deploymentDecision({ ...target, event: { workflow_run: { id: 13, head_sha: commit } } }),
  ).toThrow();
  expect(() =>
    deploymentDecision({ ...target, eventName: 'workflow_dispatch', ref: 'refs/heads/feature' }),
  ).toThrow();
  expect(
    deploymentDecision({ ...target, eventName: 'workflow_dispatch', ref: 'refs/heads/main' })
      .deploy,
  ).toBe(true);
});
test('verification inventory includes every public page, asset and an HTTP 404 probe', () => {
  const dir = mkdtempSync('/tmp/sal-public-sites-');
  try {
    mkdirSync(join(dir, 'agents'));
    for (const [name, content] of Object.entries({
      'index.html': '<html>Home</html>',
      'agents/index.html': '<html>Agents</html>',
      'install.sh': '#!/bin/sh',
      '404.html': '404',
      _headers: 'headers',
      'llms.txt': 'Docs',
    }))
      writeFileSync(join(dir, name), content);
    const files = publicFiles(dir, 'https://example.test');
    expect(files.map((f: any) => new URL(f.url).pathname).sort()).toEqual(
      ['/', '/__salaam_missing_page_check__/', '/agents/', '/install.sh', '/llms.txt'].sort(),
    );
    expect(files.filter((f: any) => f.html)).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const body = '<html>Current page</html>';
const file = {
  url: 'https://example.test/agents/',
  status: 200,
  html: true,
  sha256: createHash('sha256').update(body).digest('hex'),
};
test('eventual propagation is retried, and success requires the checked bytes', async () => {
  let calls = 0;
  const result = await verifyPublicFiles([file], {
    attempts: 2,
    sleep: async () => {},
    fetcher: async () =>
      new Response(++calls === 1 ? 'old page' : body, { headers: { 'content-type': 'text/html' } }),
  });
  expect(result.success).toBe(true);
  expect(result.results[0].attempts).toBe(2);
});
test.each([
  [200, 'stale build', 'text/html'],
  [404, body, 'text/html'],
  [200, body, 'text/plain'],
  [302, body, 'text/html'],
])(
  'published verification rejects wrong bytes, status and content type: %s %s %s',
  async (status, bytes, type) => {
    const result = await verifyPublicFiles([file], {
      attempts: 1,
      fetcher: async () => new Response(bytes, { status, headers: { 'content-type': type } }),
    });
    expect(result.success).toBe(false);
  },
);
test('HTTP errors, network failures and broken 404 handling remain failed evidence', async () => {
  const network = await verifyPublicFiles([file], {
    attempts: 1,
    fetcher: async () => {
      throw Error('offline');
    },
  });
  expect(network.success).toBe(false);
  const missing = await verifyPublicFiles([{ url: 'https://example.test/missing/', status: 404 }], {
    attempts: 1,
    fetcher: async () => new Response('home'),
  });
  expect(missing.success).toBe(false);
});
