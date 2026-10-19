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

## Connect automatic builds in the Cloudflare dashboard

Connect the two existing Workers to `SuperJackfruitLabs/salaam` in each Worker's
Settings > Build page. Keep production on `main`, set the root directory to the
repository root (`/`), and disable non-production branch deployments. No new
Workers, domains or GitHub deployment secret are needed for this connection.

Set build variables `NODE_VERSION=26.7.0` and `SKIP_DEPENDENCY_INSTALL=1` for both
Workers. Use this build command to install the exact npm version, install from all
three pinned lockfiles with scripts disabled, and check cross-site links:

```sh
npm install --global npm@11.19.0 --ignore-scripts && npm ci --ignore-scripts && npm --prefix landing ci --ignore-scripts && npm --prefix docs-site ci --ignore-scripts && npm run sites:build
```

Use a different deploy command for each Worker:

| Worker           | Production domain | Deploy command                                                                                   |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `salaam-landing` | `salaam.sh`       | `node scripts/deploy-sites.mjs --built --site landing && npm run sites:verify -- --site landing` |
| `salaam-docs`    | `docs.salaam.sh`  | `node scripts/deploy-sites.mjs --built --site docs && npm run sites:verify -- --site docs`       |

Each build checks both sites, but publishes and verifies only its selected Worker.
This prevents two independent dashboard builds from racing to deploy both domains
or failing verification while the other domain is still updating. The deployer
uses explicit configs from a scratch directory, avoiding Astro auto-scaffolding.
Cloudflare manages authentication for the connected build. The dashboard connection
is an operator setup step; these settings alone do not establish that it is active.
See [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
and [build image variables](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).

The optional GitHub `Deploy public sites` workflow remains manual-only on main.
It requires the `websites` environment's `CLOUDFLARE_ACCOUNT_ID` variable and
`CLOUDFLARE_API_TOKEN` secret if used. Local OAuth deployment and dashboard builds
do not require a token stored in GitHub. Never copy OAuth credentials into Git
or workflow source.

## Verify public deployments

After publishing, `npm run sites:verify` fetches every generated public HTML page
and static asset from both canonical domains, requires the expected HTTP status
and matching SHA-256 bytes, and checks a missing-page response on each host.
This covers the guides, navigation assets, diagram JavaScript, local search,
robots/sitemaps, llms exports and hosted installer. Short propagation delays are
retried. Failed verification exits unsuccessfully and preserves results in
`.state/sites-verification.json`. Local verification uses the latest local builds;
build the exact reviewed source first. Use `--site landing` or `--site docs` to
verify only one independently deployed Worker.

Website deployment is independent of CLI version tags. Update landing claims and
docs with behavior changes, and preserve source/build/deployment distinctions in
release notes. A build alone does not establish deployment.
