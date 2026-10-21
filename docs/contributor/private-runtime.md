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
private packet using the pinned Node archive, then starts the already-provisioned
digest-pinned Node coding image with `--network none` and `--pull=never`. Only
inside that disposable container, it removes global Node/npm, checks their
absence, installs the private packet, and exercises four concurrent starts,
pinned Pi readiness, an offline turn, and restart/reconnect retaining its attempt.
No checkout, dependency tree, Docker socket or credentials are mounted into this
fixture. Global Node paths on the host are never changed.

The CI artifact includes `.state/evidence/m22/private-runtime.json` with package,
archive, manifest, image and workflow identities. The existing CI evidence gate
requires this receipt and rejects incomplete or mismatched proof fields. This is
a Linux container fixture, not a deployed-fleet claim. Syntax and fixture tests
alone do not prove it passed; inspect a successful CI execution before claiming
the real Linux install/start acceptance.
