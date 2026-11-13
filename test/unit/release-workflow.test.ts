import { expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/core/config.js';

// A v* tag runs the suite's shared release workflow (.github/workflows/release.yml, synced
// byte-identical). What is Salaam's is .github/release-config.json and its hooks at fixed paths,
// .github/release/{check,publish}.sh: these tests hold them together with ci.yml.
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const config: {
  ci_workflow: string;
  artifact: string;
  check?: unknown;
  build_at_tag?: boolean;
  publish: { script?: string; environment: string; after_release: boolean };
} = JSON.parse(read('.github/release-config.json'));

test('the release ships the package main CI built and certified, never a rebuild', () => {
  expect(config.ci_workflow).toBe('ci.yml');
  expect(config.build_at_tag).toBeUndefined();
  // The artifact the workflow downloads is the one ci.yml's package-build uploads.
  const ci = read('.github/workflows/ci.yml');
  expect(config.artifact).toBe('salaam-cli-{attempt}');
  expect(ci).toContain('name: salaam-cli-${{ github.run_attempt }}');
  // ...and the gate's check proves it is the certified, attested one before anything is drafted.
  // The workflow runs hooks at fixed paths, never a command read from the config.
  expect(config.check).toBeUndefined();
  const check = read('.github/release/check.sh');
  expect(check).toContain('node scripts/release-check.mjs "$TAG"');
  expect(check).toContain('node scripts/release-source.mjs');
  const source = read('scripts/release-source.mjs');
  expect(source).toContain('process.env.CI_RUN_ID');
  expect(source).toContain('`salaam-cli-${run.run_attempt}`');
  expect(source).toContain("'--signer-workflow',");
});

test('npm gets the released tarball after the release, through trusted publishing', () => {
  expect(config.publish).toEqual({ environment: 'npm', after_release: true });
  expect(read('.github/release/publish.sh')).toContain('sh deploy/release/npm-publish.sh');
  expect(read('deploy/release/npm-publish.sh')).toContain('node scripts/npm-release.mjs');
  expect(read('scripts/npm-release.mjs')).toContain('process.env.RELEASE_DIST');
});

test('the shared workflow is the release: no stop-gap summary or publisher remains', () => {
  const release = read('.github/workflows/release.yml');
  expect(release).toMatch(/^# Shared release workflow for the SuperJackfruit suite\./);
  expect(release).toContain('publish-after-release:');
  for (const gone of [
    '.github/workflows/release-summary.yml',
    'scripts/github-release.mjs',
    'scripts/previous-tag.mjs',
  ])
    expect(existsSync(join(ROOT, gone)) ? gone : null).toBeNull();
});
