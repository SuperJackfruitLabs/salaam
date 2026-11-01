import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { root } from './release-check.mjs';
import { site, docs } from '../site.config.mjs';

const builds = [
  { url: new URL(site), path: join(root, 'landing/dist') },
  { url: new URL(docs), path: join(root, 'docs-site/dist') },
];
let pages = 0,
  links = 0;
const failures = [];
function htmlPath(path) {
  if (existsSync(path) && statSync(path).isFile()) return path;
  const index = join(path, 'index.html');
  if (existsSync(index)) return index;
  // Astro's static 404 canonical is /404/, while the actual fallback is 404.html.
  const flat = path.replace(/\/$/, '') + '.html';
  return existsSync(flat) ? flat : null;
}
function walk(directory, build) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file, build);
      continue;
    }
    if (extname(file) !== '.html') continue;
    pages++;
    const content = readFileSync(file, 'utf8');
    if (!/<title>[^<]+<\/title>/.test(content)) failures.push(`${file}: missing title`);
    for (const match of content.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const href = match[1].replaceAll('&amp;', '&');
      if (/^(?:data:|mailto:|javascript:)/.test(href)) continue;
      const pageUrl = new URL(file.slice(build.path.length).replace(/index\.html$/, ''), build.url);
      const url = new URL(href, pageUrl);
      const target = builds.find((b) => b.url.origin === url.origin);
      if (!target) continue;
      const path = htmlPath(resolve(target.path, '.' + decodeURIComponent(url.pathname)));
      links++;
      if (!path) failures.push(`${file}: ${href} does not exist`);
    }
  }
}
for (const build of builds) walk(build.path, build);
const hostedInstaller = join(builds[0].path, 'install.sh');
if (
  !existsSync(hostedInstaller) ||
  !readFileSync(hostedInstaller).equals(readFileSync(join(root, 'install.sh')))
)
  failures.push('Hosted installer is missing or differs from the canonical release installer');
// Contributor material must not leak through standalone routes, search or exports.
for (const internal of ['milestones', 'sites', 'releases', 'verification', 'execution-boundary'])
  if (existsSync(join(builds[1].path, internal, 'index.html')))
    failures.push('Contributor-only route leaked into public docs: ' + internal);
const allDocs = readFileSync(join(builds[1].path, 'llms-full.txt'), 'utf8');
if (
  /\bM\d+(?:\.\d+)?\b|Website maintenance|## Scope and proofs|remote-rehearsal\.mjs|test\/proofs\/|\.state\/evidence\//.test(
    allDocs,
  )
)
  failures.push('Implementation history or maintenance content leaked into public documentation');
for (const required of [
  'index.html',
  'install/index.html',
  'quickstart/index.html',
  'troubleshooting/index.html',
  'cli/index.html',
  'editors/index.html',
  'permissions/index.html',
  'sandbox/index.html',
  'rules/index.html',
  'jobs/index.html',
  'agents/index.html',
  'external-harnesses/index.html',
  'a2a/index.html',
  'reliability/index.html',
  'security/index.html',
  'llms.txt',
  'llms-full.txt',
])
  if (!existsSync(join(builds[1].path, required)))
    failures.push('Missing docs output: ' + required);
if (!existsSync(join(builds[1].path, 'pagefind'))) failures.push('Missing local docs search index');
if (failures.length) throw new Error(failures.join('\n'));
console.log(
  JSON.stringify(
    {
      pages,
      internal_links_and_assets: links,
      local_search: true,
      llms_exports: true,
      canonical_installer: true,
      broken_links: 0,
    },
    null,
    2,
  ),
);
