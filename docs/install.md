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
curl -fsSL https://salaam.sh/install.sh | sh -s -- --version 0.0.2 --prefix "$HOME/.local"
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
npm install --global --ignore-scripts --offline --no-audit --no-fund ./salaam-cli-0.0.2.tgz
```

Production dependencies are bundled from the reviewed lockfile. The package includes
compiled code, source for host manifest hashing, the Pi pin, a shrinkwrap, licenses
and release notes. It excludes service state, credentials, tests, site builds and
development dependencies. No checkout or compiler is needed.

## npm registry

Install a specific published version:

```sh
npm install --global @superjackfruitlabs/salaam@0.0.2 --ignore-scripts
```

## Private runtime packet (Linux x64)

The additive private installer needs no system Node or npm. It requires a Linux
x64 glibc host with `/bin/sh`, `/usr/bin/env`, `/usr/bin/dirname`, GNU tar, `awk`,
`sha256sum` (or `shasum`), and the standard Node shared-library requirements. This packet is
private build output; no public release, image, or deployment is implied.

Runtime maintainers can follow the [private build instructions](contributor/private-runtime.md).

Transfer only this packet and its reviewed digest to the clean host:

```sh
sh install.sh --private-runtime ./salaam-private.tar.gz \
  --sha256 REVIEWED_ARCHIVE_SHA256 --prefix "$HOME/.local/salaam-private"
"$HOME/.local/salaam-private/bin/salaam" --version
```

The installer checks the archive hash before extraction or executing bundled
code, rejects unsafe archive entry types and paths before extraction, then
verifies the full manifest inventory. The prefix is dedicated to
private installations. It contains `releases/MANIFEST_SHA256`, an atomically
switched `current` link, and `bin/salaam` / `bin/sal`. The launcher invokes the
bundled Node by absolute path under `env -i`; it retains only HOME, TMPDIR, fixed
locale and a private/system utility PATH. Provider credentials must use the
existing explicit configuration path; inherited provider keys, `NODE_OPTIONS`,
and permission environment variables are intentionally absent. Create/review a
host manifest with this installed launcher and its final installation path, then
use the normal `host start MANIFEST` command. Installing never starts a daemon
or authorizes a managed operation.

To replace an installed runtime, stop the service, back up the stopped state,
and provide its actual SQLite database path:

```sh
sh install.sh --private-runtime ./salaam-private.tar.gz \
  --sha256 REVIEWED_ARCHIVE_SHA256 --prefix "$HOME/.local/salaam-private" \
  --database /absolute/path/to/state/journal.sqlite --stopped
```

`--stopped` records operator intent. Activation additionally acquires the same
OS-backed exclusive SQLite transactions used by native configuration apply, in
the same order: `startup/owner.sqlite`, `host/owner.sqlite`, then the daemon's
`owner.sqlite`. It retains all three through replacement of `current`. A live
startup, host supervisor or daemon owner prevents activation even when `--stopped`
is supplied. Missing startup/host lock directories are created privately before
acquisition, preventing a concurrent first startup from racing an absence check.
The supplied journal must be named `journal.sqlite`, exist beneath its canonical
user-owned private state directory, and have a canonical existing `owner.sqlite`;
Lock directories and files must also be canonical, private and user-owned;
symlink aliases and outside journal paths are rejected. Activation reads journal
`user_version` read-only and refuses unsupported schemas before changing `current`.
The pin's supported schema range must track Store migrations;
the current maximum is 31. Installation neither migrates nor restores a database.
Rollback uses the previous reviewed archive and a matching stopped-state backup
through the same command and checks; `previous-runtime` records the previous
pointer for inspection. Recreate host manifests after switching versions. Do not
manually repoint `current` to bypass compatibility checks. A matching schema
number alone cannot prove semantic compatibility of an arbitrary old package.

Installation serialization also uses an OS-backed SQLite lock. Process death
releases these locks without stale-PID or timeout guesses. Each attempt owns a
fresh staging directory and pointer; leftovers from a killed attempt do not
block retries. Cleanup removes only that attempt's resources, never unknown
pre-existing staging directories or pointers.

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
