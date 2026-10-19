import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { site, docs } from '../site.config.mjs';
import { selectedSiteProjects } from './site-targets.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function publicFiles(directory, base) {
  const result = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (
        entry.isFile() &&
        !['404.html', '_headers', '_redirects', '.assetsignore'].includes(entry.name)
      ) {
        const name = relative(directory, file).replaceAll('\\', '/');
        const route = name.endsWith('index.html') ? name.slice(0, -10) : name;
        result.push({
          url: new URL(route, base.endsWith('/') ? base : base + '/').href,
          status: 200,
          sha256: hash(readFileSync(file)),
          html: name.endsWith('.html'),
        });
      }
    }
  }
  walk(directory);
  result.push({ url: new URL('/__salaam_missing_page_check__/', base).href, status: 404 });
  return result;
}

export async function verifyPublicFiles(
  files,
  {
    fetcher = fetch,
    attempts = 5,
    delayMs = 5000,
    concurrency = 6,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (
    !files.length ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1
  )
    throw Error('Invalid verification plan');
  const results = new Array(files.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= files.length) return;
        const file = files[index];
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            const response = await fetcher(file.url, {
              redirect: 'manual',
              signal: AbortSignal.timeout(20000),
              headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'Salaam-public-site-verifier' },
            });
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (response.status !== file.status)
              throw Error(`Expected HTTP ${file.status}, received ${response.status}`);
            if (file.html && !response.headers.get('content-type')?.includes('text/html'))
              throw Error('Page is not HTML');
            if (
              file.url.endsWith('/install.sh') &&
              !response.headers.get('content-type')?.includes('text/plain')
            )
              throw Error('Installer is not plain text');
            const actual = hash(bytes);
            if (file.sha256 && actual !== file.sha256)
              throw Error('Published bytes differ from the checked build');
            results[index] = {
              url: file.url,
              status: response.status,
              sha256: actual,
              attempts: attempt,
              success: true,
            };
            break;
          } catch (error) {
            if (attempt === attempts)
              results[index] = { url: file.url, success: false, error: error.message };
            else await sleep(delayMs);
          }
        }
      }
    }),
  );
  return {
    success: results.every((r) => r.success),
    checked: results.length,
    html_pages: files.filter((f) => f.html).length,
    results,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const targets = selectedSiteProjects(process.argv.slice(2)).map((project) => ({
    directory: join(root, project, 'dist'),
    base: project === 'landing' ? site : docs,
  }));
  const report = await verifyPublicFiles(targets.flatMap((t) => publicFiles(t.directory, t.base)));
  report.commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  report.verified_at = new Date().toISOString();
  mkdirSync(join(root, '.state'), { recursive: true });
  writeFileSync(
    join(root, '.state/sites-verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        success: report.success,
        commit: report.commit,
        html_pages: report.html_pages,
        checked: report.checked,
        failures: report.results.filter((r) => !r.success),
      },
      null,
      2,
    ),
  );
  if (!report.success) process.exitCode = 1;
}
