import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ROOT } from '../../src/config.js';

const { publicFiles, verifyPublicFiles } = await import(
  pathToFileURL(join(ROOT, 'scripts/verify-sites.mjs')).href
);
const { selectedSiteProjects } = await import(
  pathToFileURL(join(ROOT, 'scripts/site-targets.mjs')).href
);
test('individual dashboard builds deploy and verify only their selected site', () => {
  expect(selectedSiteProjects([])).toEqual(['landing', 'docs-site']);
  expect(selectedSiteProjects(['--built', '--site', 'landing'], ['--built'])).toEqual(['landing']);
  expect(selectedSiteProjects(['--site', 'docs'])).toEqual(['docs-site']);
});
test.each([
  ['--site'],
  ['--site', 'typo'],
  ['--siet', 'landing'],
  ['--site', 'landing', '--site', 'docs'],
])('invalid site selection cannot deploy an unintended target: %j', (...args) => {
  expect(() => selectedSiteProjects(args)).toThrow();
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
