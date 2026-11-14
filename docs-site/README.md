# Salaam documentation

Astro + Starlight, with local search, light/dark themes and llms.txt exports. It wears the
suite's docs theme, `@superjackfruit/docs-theme` (vendored under `vendor/` with the frontdoor
and vibekit tarballs it needs, as the landing page vendors its own). The whole design config is
`sjlDocs({ product: 'salaam', status: 'half-lit' })` in `astro.config.mjs`: vibekit's pink, the
suite's faces (self-hosted), the street, status badges, Copy Markdown and `<page>.md`, the suite
footer, the 404 and `/llms.txt`, `/llms-full.txt` and `/llms-small.txt` (`starlight-llms-txt`,
through the theme, with every published page listed in `llms.txt`). The status is half-lit
because Salaam is early software with the gaps [Recovery and limitations](../docs/limitations.md)
names.

`docs/` is the canonical source. `pages.json` is the allowlist of published pages; the build
(`scripts/sync-docs.mjs`) regenerates the ignored content collection from those files, with
working site routes and edit links to the original Markdown. Edit those originals, then rebuild;
there is no second copy to maintain. The sidebar in `astro.config.mjs` uses the suite's groups
(Start, Use it, Build on it, Run it, Reference); the theme warns at build time when a top-level
group is anything else.

The home is the theme's `BentoHome`, in `src/home.mdx`, above the text of `docs/index.md`. The
home is built as MDX, so `docs/index.md` must parse as MDX too: no bare `{` or `<` outside code.

Use the pinned repository Node/npm versions. `npm ci --ignore-scripts`, then
`npm run dev` (port 4342) or `npm run build`.

See [site operation](../docs/sites.md).
