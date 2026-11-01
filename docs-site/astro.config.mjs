import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { docs, repo, description } from '../site.config.mjs';

export default defineConfig({
  site: docs,
  integrations: [
    starlight({
      title: 'Salaam',
      description,
      logo: { src: './src/assets/mark.svg', alt: '' },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/theme.css'],
      components: { MarkdownContent: './src/components/MarkdownContent.astro' },
      editLink: { baseUrl: `${repo}/edit/main/docs/` },
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      sidebar: [
        { label: 'Intro', slug: '' },
        { label: 'Install', slug: 'install' },
        { label: 'Providers', slug: 'providers' },
        { label: 'Troubleshooting', slug: 'troubleshooting' },
        {
          label: 'Usage',
          items: [
            { label: 'Terminal', slug: 'tui' },
            { label: 'CLI', slug: 'cli' },
            { label: 'Editors', slug: 'editors' },
            { label: 'Durable tasks', slug: 'durable-tasks' },
            { label: 'Jobs and schedules', slug: 'jobs' },
            { label: 'Try it offline', slug: 'quickstart' },
          ],
        },
        {
          label: 'Configure',
          items: [
            { label: 'Permissions', slug: 'permissions' },
            { label: 'Sandbox', slug: 'sandbox' },
            { label: 'Rules', slug: 'rules' },
            { label: 'Commands', slug: 'commands' },
            { label: 'Hooks', slug: 'hooks' },
            { label: 'MCP servers', slug: 'mcp' },
            { label: 'Specialists and teams', slug: 'agents' },
            { label: 'External harnesses', slug: 'external-harnesses' },
            { label: 'A2A peers', slug: 'a2a' },
            { label: 'Coding in a container', slug: 'coding' },
          ],
        },
        {
          label: 'Operate',
          items: [
            { label: 'ACP and SSH reference', slug: 'clients' },
            { label: 'Service reference', slug: 'service-reference' },
            { label: 'Host operation', slug: 'host-operation' },
            { label: 'Security', slug: 'security' },
            { label: 'Recovery and limitations', slug: 'limitations' },
            { label: 'Reliability and support', slug: 'reliability' },
            { label: 'Task context', slug: 'task-context' },
            { label: 'Architecture', slug: 'architecture' },
          ],
        },
      ],
    }),
  ],
});
