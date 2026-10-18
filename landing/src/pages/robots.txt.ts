import { site } from '../../../site.config.mjs';
export const prerender = true;
export function GET() {
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);
}
