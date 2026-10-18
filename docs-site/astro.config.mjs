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
        {
          label: 'Start',
          items: [
            { label: 'Meet Salaam', slug: '' },
            { label: 'Install and upgrade', slug: 'install' },
            { label: 'Your first session', slug: 'quickstart' },
            { label: 'Providers and credentials', slug: 'providers' },
          ],
        },
        {
          label: 'Use',
          items: [
            { label: 'Terminal interface', slug: 'tui' },
            { label: 'Coding and execution', slug: 'coding' },
            { label: 'Durable tasks', slug: 'durable-tasks' },
            { label: 'Specialists and teams', slug: 'agents' },
            { label: 'External harnesses', slug: 'external-harnesses' },
            { label: 'A2A peers', slug: 'a2a' },
            { label: 'Jobs and schedules', slug: 'jobs' },
            { label: 'Editors and SSH', slug: 'clients' },
            { label: 'Session operations', slug: 'service-reference' },
          ],
        },
        {
          label: 'Operate',
          items: [
            { label: 'Host supervision', slug: 'host-operation' },
            { label: 'Recovery and limitations', slug: 'limitations' },
          ],
        },
        {
          label: 'Understand',
          items: [
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Security and isolation', slug: 'security' },
            { label: 'Task context', slug: 'task-context' },
            { label: 'Reliability and support', slug: 'reliability' },
          ],
        },
      ],
    }),
  ],
});
