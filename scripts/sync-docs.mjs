import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './release-check.mjs';

// docs/ is canonical. The site's generated collection is ignored; never hand-edit it.
const target = join(root, 'docs-site/src/content/docs');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
// A deliberate allowlist prevents contributor docs from entering navigation,
// local search, static output or machine-readable exports.
const pages = JSON.parse(readFileSync(join(root, 'docs-site/pages.json'), 'utf8'));
// The docs home is the suite theme's BentoHome (docs-site/src/home.mdx: its frontmatter, imports
// and component) above the canonical Intro, docs/index.md, which stays the home's text. The home is
// MDX, so docs/index.md must also parse as MDX: no bare `{` or `<` outside code.
const home = readFileSync(join(root, 'docs-site/src/home.mdx'), 'utf8').match(
  /^---\n([\s\S]*?)\n---\n([\s\S]*)$/,
);
if (!home) throw new Error('docs-site/src/home.mdx needs frontmatter');
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
  const editUrl = `https://github.com/SuperJackfruitLabs/salaam/edit/main/docs/${file}`;
  if (slug === 'index')
    writeFileSync(
      join(target, 'index.mdx'),
      `---\n${home[1]}\neditUrl: ${editUrl}\n---\n${home[2]}\n${rendered}`,
    );
  else
    writeFileSync(
      join(target, file),
      `---\ntitle: ${JSON.stringify(title)}\neditUrl: ${editUrl}\n---\n${rendered}`,
    );
}
// llms.txt, llms-full.txt and llms-small.txt are the docs theme's (starlight-llms-txt), built from
// this same collection. Copies an older build left in public/ would shadow them.
for (const stale of ['llms.txt', 'llms-full.txt'])
  rmSync(join(root, 'docs-site/public', stale), { force: true });
