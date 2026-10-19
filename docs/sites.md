# Landing page and documentation site

Salaam follows the org's supertoolkit, superwitness and superpipeline pattern:
a separate Astro landing project, a Starlight docs project, matching product
branding, Markdown source docs, and asset-only Cloudflare Workers.

- `landing/` builds `https://salaam.sh`.
- Its build and dev hooks copy the canonical root `install.sh` to the ignored
  `landing/public/install.sh`, served at `https://salaam.sh/install.sh`. Edit the
  root script; the site build rejects a missing or different copy. Static asset
  headers serve the script as plain text with MIME sniffing disabled.
- `docs-site/` builds `https://docs.salaam.sh`, local search and llms.txt exports.
- `docs/` holds canonical documentation. An explicit user-page allowlist controls site output, search and machine-readable exports. Builds regenerate the ignored content
  collection and convert relative Markdown links to routes. Edit links point back
  to these original documents, not generated files.
- `site.config.mjs` defines canonical/cross-site URLs. Environment variables
  `SALAAM_SITE_URL` and `SALAAM_DOCS_URL` override them for a deliberate staging build.
- The Night/Paper colors come from Salaam's existing TUI. The mark comes from the suite’s translucent-v2 Salaam Nod assets (provisional
  in the brand handoff); the static illustrative terminal is source HTML; the larger screenshot is an
  actual offline acceptance fixture, labelled as such.

## Build and preview

Use repository Node/npm versions. The sites have independent pinned lockfiles;
their framework dependencies are excluded from the CLI release package.

```sh
npm ci --ignore-scripts
npm --prefix landing ci --ignore-scripts
npm --prefix docs-site ci --ignore-scripts
npm run sites:build
npm --prefix landing run dev
# In another terminal:
npm --prefix docs-site run dev
```

The previews use ports 4341 and 4342. To keep cross-site navigation local, set
`SALAAM_SITE_URL=http://localhost:4341` and
`SALAAM_DOCS_URL=http://localhost:4342` for both processes.

Every build checks generated internal links and assets across both sites, required
entry pages (including specialists, harnesses and A2A), search and llms exports.
CI runs these builds on main and PRs.
The README stays short; detailed commands and recovery guidance live in docs.

## Deploy with existing Cloudflare login

```sh
node scripts/deploy-sites.mjs --dry-run
node scripts/deploy-sites.mjs
```

Use the operator's existing `wrangler login`. The checked-in configs declare only
`salaam.sh/*` and `docs.salaam.sh/*`, with host-specific Worker routes, static asset directories and
404 behavior. They create no application server, database, public session API or
credential storage. Deployment uses explicit configs from a scratch directory so
Wrangler cannot auto-scaffold an Astro adapter and rewrite source files. The routes
preserve existing proxied DNS records; custom-domain creation refuses those existing
records. No DNS record is deleted or replaced by this deployment.

The script builds and checks before deploying. `--built` rechecks existing outputs
when the exact build already passed. A successful dry run is configuration
validation, not evidence that a domain is live; verify production separately.

## Automatic CI deployment

`Deploy public sites` runs automatically after successful push CI on main. It
checks out that exact tested commit, builds and checks both sites, then deploys
through the main-only `websites` GitHub environment. PRs, forks, failed CI and
scheduled/feature runs cannot authorize deployment. A superseded main revision is
skipped, including a freshness check immediately before publishing. Deployments
are serialized so an older slow run cannot overwrite a newer deployment.

Manual main retries remain available. They require successful push CI for the
same current main commit; they cannot bypass the source or CI check.

Configure `CLOUDFLARE_ACCOUNT_ID` as an environment/repository variable and a
scope-limited `CLOUDFLARE_API_TOKEN` as an environment secret. It needs access to
the deployment account with Workers Scripts: Edit, and to the `salaam.sh` zone
with Workers Routes: Edit and Zone: Read. Never copy OAuth credentials into Git
or workflow source. No token is required for local OAuth deployment.

After publishing, `npm run sites:verify` fetches every generated public HTML page
and static asset from both canonical domains, requires the expected HTTP status
and matching SHA-256 bytes, and checks a missing-page response on each host.
This covers the guides, navigation assets, diagram JavaScript, local search,
robots/sitemaps, llms exports and hosted installer. Short propagation delays are
retried. Failed verification fails the deployment workflow, preserving the
results and source/CI identity in its verification artifact. Local verification
uses the latest local builds; build the exact reviewed source first.

Website deployment is independent of CLI version tags. Update landing claims and
docs with behavior changes, and preserve source/build/deployment distinctions in
release notes. A build alone does not establish deployment.
