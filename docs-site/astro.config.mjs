import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sjlDocs from '@superjackfruit/docs-theme';
import { docs, repo, description } from '../site.config.mjs';

// llms.txt lists every published page, in pages.json order, by its docs/*.md title.
const pages = JSON.parse(readFileSync(new URL('./pages.json', import.meta.url), 'utf8'));
const pageList = pages
  .map((slug) => {
    const text = readFileSync(new URL(`../docs/${slug}.md`, import.meta.url), 'utf8');
    return `- [${text.match(/^# (.+)/m)?.[1]}](${docs}/${slug === 'index' ? '' : slug + '/'})`;
  })
  .join('\n');

export default defineConfig({
  site: docs,
  integrations: [
    starlight({
      title: 'Salaam',
      description,
      // The suite's docs theme: vibekit's pink, the faces, the street, status badges, the footers,
      // the 404 and llms.txt. See @superjackfruit/docs-theme's README.
      plugins: [
        sjlDocs({
          product: 'salaam',
          // Early software with the gaps docs/limitations.md names.
          status: 'half-lit',
          // /llms.txt, /llms-full.txt and /llms-small.txt, for agents reading these docs.
          llms: { description, details: `## User documentation\n\n${pageList}` },
        }),
      ],
      favicon: '/favicon.svg',
      // Mermaid diagrams (architecture.md); see the component.
      components: { MarkdownContent: './src/components/MarkdownContent.astro' },
      // docs/ is canonical: each generated page also carries its own editUrl to its original.
      editLink: { baseUrl: `${repo}/edit/main/docs/` },
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      // The suite's five groups, in the order a reader needs them. No page moves, so no URL changes.
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Intro', slug: '' },
            { label: 'Install', slug: 'install' },
            { label: 'Try it offline', slug: 'quickstart' },
            { label: 'Providers', slug: 'providers' },
          ],
        },
        {
          label: 'Use it',
          items: [
            { label: 'Terminal', slug: 'tui' },
            { label: 'CLI', slug: 'cli' },
            { label: 'Editors', slug: 'editors' },
            { label: 'Permissions', slug: 'permissions' },
            { label: 'Sandbox', slug: 'sandbox' },
            { label: 'Rules', slug: 'rules' },
            { label: 'Durable tasks', slug: 'durable-tasks' },
            { label: 'Jobs and schedules', slug: 'jobs' },
            { label: 'Coding in a container', slug: 'coding' },
          ],
        },
        {
          label: 'Build on it',
          items: [
            { label: 'Commands', slug: 'commands' },
            { label: 'Hooks', slug: 'hooks' },
            { label: 'MCP servers', slug: 'mcp' },
            { label: 'Specialists and teams', slug: 'agents' },
            { label: 'External harnesses', slug: 'external-harnesses' },
            { label: 'A2A peers', slug: 'a2a' },
          ],
        },
        {
          label: 'Run it',
          items: [
            { label: 'Host operation', slug: 'host-operation' },
            { label: 'Security', slug: 'security' },
            { label: 'Reliability and support', slug: 'reliability' },
            { label: 'Recovery and limitations', slug: 'limitations' },
            { label: 'Troubleshooting', slug: 'troubleshooting' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'ACP and SSH reference', slug: 'clients' },
            { label: 'Service reference', slug: 'service-reference' },
            { label: 'Task context', slug: 'task-context' },
            { label: 'Architecture', slug: 'architecture' },
          ],
        },
      ],
    }),
  ],
});
