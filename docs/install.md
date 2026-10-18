# Install and upgrade Salaam

Use Node **26.7.0** and npm **11.19.0**. The Node version is intentionally exact:
Salaam uses built-in SQLite and proves process behavior against this runtime.
macOS and Linux are supported; Windows is untested. No database server is needed.

With nvm installed, run `nvm install 26.7.0`, `nvm use 26.7.0`, and
`npm install --global npm@11.19.0 --ignore-scripts`.

## Install with one command

Install the latest stable GitHub Release:

```sh
curl -fsSL https://salaam.sh/install.sh | sh
salaam --version
sal --help
```

You can [read the installer](https://salaam.sh/install.sh) before running it. To
select a version and install under your account, pass arguments after `sh -s --`:

```sh
curl -fsSL https://salaam.sh/install.sh | sh -s -- --version 0.0.1 --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

Omit `--prefix` to use npm's global prefix. Prereleases require `--version`.
Installation leaves services, state and credentials untouched. The installer for
a particular release is also available from its
[GitHub Release assets](https://github.com/SuperJackfruitLabs/salaam/releases).

The script requires `node`, `npm` and `curl`, enforces Node's version, downloads
the tarball and `SHA256SUMS` over HTTPS, checks the exact asset's hash, then installs
offline with lifecycle scripts disabled. A mismatch aborts before npm runs.
Checksums detect corruption; they are not an independent trust root if the same
release account is compromised. Build attestations can be checked with
`gh attestation verify TARBALL --repo SuperJackfruitLabs/salaam`.

## Direct tarball installation

Download `salaam-cli-VERSION.tgz` and `SHA256SUMS` from the **same** release. Verify
the tarball's listed SHA-256 digest (`sha256sum` on Linux or `shasum -a 256` on
macOS), then install:

```sh
npm install --global --ignore-scripts --offline --no-audit --no-fund ./salaam-cli-0.0.1.tgz
```

Production dependencies are bundled from the reviewed lockfile. The package includes
compiled code, source for host manifest hashing, the Pi pin, a shrinkwrap, licenses
and release notes. It excludes service state, credentials, tests, site builds and
development dependencies. No checkout or compiler is needed.

## npm registry

Install a specific published version:

```sh
npm install --global @superjackfruitlabs/salaam@0.0.1 --ignore-scripts
```

## Upgrade deliberately

Installing files does not update a running daemon. Finish or explicitly pause
work, inspect unknown operations, and stop the service or its native supervisor.
Back up the **stopped** state directory, including SQLite WAL files and Pi histories,
with private permissions. Install the selected version, review the changelog, then
restart with the same provider, state, workspace and backend configuration.

Host manifests pin the installation path and source/build/Pi digests. Regenerate
and review a manifest after upgrades or moves; an old manifest must reject changed
files. Never replace a package while its pinned host is running.

State migrations are forward-only. Rollback means restoring the stopped pre-upgrade
backup with its matching runtime and package, not opening upgraded state with an
older binary.

## Source install and removal

```sh
git clone https://github.com/SuperJackfruitLabs/salaam.git
cd salaam
nvm use
npm ci --ignore-scripts
npm run setup:cli
```

This links aliases to the checkout. Rebuild after edits; repeat setup after moving
it or changing Node. Remove a release package with
`npm uninstall --global @superjackfruitlabs/salaam --ignore-scripts`; remove a checkout link with
`npm unlink --global @superjackfruitlabs/salaam --ignore-scripts --offline`. Neither removes saved
credentials or service state. Stop owned services first.
