import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { site } from '../site.config.mjs';
export default defineConfig({ site, integrations: [sitemap({ filter: (page) => !page.includes('/404') })] });
