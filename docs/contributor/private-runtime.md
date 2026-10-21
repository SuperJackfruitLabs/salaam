# Private runtime build and verification

These are contributor instructions. See [installation](../install.md) for using
a reviewed private packet.

On the matching Linux build host, obtain the reviewed release tarball and the
Node archive specified in `scripts/runtime-pin.json`. Supply the release
tarball's independently reviewed SHA-256, and build with the pinned Node:

```sh
node scripts/private-runtime-pack.mjs node-v26.7.0-linux-x64.tar.xz \
  salaam-cli-VERSION.tgz REVIEWED_PACKAGE_SHA256 salaam-private.tar.gz
```

The builder verifies both archives, enforces Node/npm pins, installs the bundled
package offline with lifecycle scripts disabled and empty npm configuration,
and creates a tarball with normalized timestamps, ordering and ownership. Build
inputs must be the same reviewed bytes. The output records archive SHA-256 and
manifest SHA-256. Internal file symlinks are materialized before packaging;
archive links and special entries are forbidden. `runtime.json` inventories
every file digest and executable mode. The allowlisted input is the release package plus pinned
Node distribution and packaging tools; no workspace, service state, credentials,
host manifests, or live permission records are copied. npm cache/logs and local
tarball path metadata are excluded.

## Acceptance evidence

Focused packaging checks: `node --test scripts/runtime/runtime.test.mjs`.
The existing `execution-boundary` CI job downloads the exact `package-build`
artifact and runs `bash scripts/private-runtime-acceptance.sh`. It builds the
private packet twice in independent staging/home/cache directories using the
same exact release tarball and pinned Node archive. Before clean-host startup,
it checks both archives' actual SHA-256 against their build records and requires
identical archive and manifest hashes. Builds run sequentially; each cleans its
staging, and the second archive is removed after comparison.

It then starts the already-provisioned digest-pinned Debian/glibc whole-harness
Node image with an explicit `/bin/sh` entrypoint, `--network none` and
`--pull=never`. The separate Alpine/musl coding image is incompatible with this
glibc Node packet. Only
inside that disposable container, it removes global Node/npm, checks their
absence, installs the private packet, and exercises four concurrent starts,
pinned Pi readiness, an offline turn, and restart/reconnect retaining its attempt.
No checkout, dependency tree, Docker socket or credentials are mounted into this
fixture. Global Node paths on the host are never changed.

The CI artifact includes `.state/evidence/m22/private-runtime.json` with package,
archive, manifest, image and workflow identities, plus both clean-build hashes.
The existing CI evidence gate requires this receipt and rejects missing or
mismatched reproducibility proof fields. This is
a Linux container fixture, not a deployed-fleet claim. Syntax and fixture tests
alone do not prove it passed; inspect a successful CI execution before claiming
the real Linux install/start acceptance.
