# Salaam documentation

Astro + Starlight, with local search, light/dark themes and llms.txt exports,
following the org's superpipeline and superwitness pattern.

`docs/` is the canonical source. The build regenerates the ignored content
collection with working site routes and edit links to the original Markdown.
Edit those originals, then rebuild; there is no second copy to maintain.

Use the pinned repository Node/npm versions. `npm ci --ignore-scripts`, then
`npm run dev` (port 4342) or `npm run build`.

See [site operation](../docs/sites.md).
