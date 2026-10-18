import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './release-check.mjs';
import { docs as docsUrl, repo, description } from '../site.config.mjs';

// docs/ is canonical. The site's generated collection is ignored; never hand-edit it.
const target = join(root, 'docs-site/src/content/docs');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
// A deliberate allowlist prevents contributor docs from entering navigation,
// local search, static output or machine-readable exports.
const pages = JSON.parse(readFileSync(join(root, 'docs-site/pages.json'), 'utf8'));
const exports = [];
for (const slug of pages) {
  const file = slug + '.md';
  let content = readFileSync(join(root, 'docs', file), 'utf8');
  const title = content.match(/^# (.+)/m)?.[1];
  if (!title) throw new Error('Missing document title: ' + file);
  content = content.replace(/^# .+\n/, '');
  // Render docs links as site routes; keep evidence and source links on GitHub.
  content = content.replace(/\]\(([^)]+)\)/g, (match, href) => {
    if (/^(https?:|#|mailto:|\/)/.test(href)) return match;
    const [path, fragment] = href.split('#');
    const suffix = fragment ? '#' + fragment : '';
    if (/^[\w-]+\.md$/.test(path) && pages.includes(path.replace(/\.md$/, '')))
      return `](../${path.replace(/\.md$/, '')}/${suffix})`;
    const repoPath = path.startsWith('../') ? path.slice(3) : 'docs/' + path;
    return `](https://github.com/SuperJackfruitLabs/salaam/blob/main/${repoPath}${suffix})`;
  });
  // Preserve fenced source for machine-readable exports, but turn diagram blocks
  // into escaped HTML before Astro's Markdown highlighter consumes them.
  const rendered = content.replace(/^```mermaid\s*\n([\s\S]*?)^```\s*$/gm, (_block, source) => {
    const escaped = source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return `<figure class="salaam-diagram"><pre class="mermaid">${escaped}</pre><noscript>Enable JavaScript to render the diagram. Its source is shown above.</noscript></figure>`;
  });
  writeFileSync(
    join(target, file),
    `---\ntitle: ${JSON.stringify(title)}\neditUrl: https://github.com/SuperJackfruitLabs/salaam/edit/main/docs/${file}\n---\n${rendered}`,
  );
  const url = `${docsUrl}/${slug === 'index' ? '' : slug + '/'}`;
  exports.push({
    title,
    url,
    content: `# ${title}\n\nSource: ${url}\n\n${content.replace(/\]\(\.\.\/([\w-]+)\//g, `](${docsUrl}/$1/`)}`,
  });
}
const publicDir = join(root, 'docs-site/public');
mkdirSync(publicDir, { recursive: true });
writeFileSync(
  join(publicDir, 'llms.txt'),
  `# Salaam\n\n> ${description}\n\n## User documentation\n\n${exports.map((p) => `- [${p.title}](${p.url})`).join('\n')}\n\n## Source\n\n- [Repository](${repo})\n`,
);
const full = exports.map((p) => p.content).join('\n\n---\n\n');
writeFileSync(join(publicDir, 'llms-full.txt'), full + '\n');
