# Salaam host operation

Use an already provisioned host with Node 26.7.0, npm 11.19.0, the locked Pi 1.3.0 dependencies, and the proven pinned Docker images/backend. The private operator and bridge sockets remain host-local; SSH is the remote boundary. Set up a dedicated service account and private directories. Keep the credential home, service state and source/build outside the coding root.

```json
{
  "state": "/srv/salaam/state",
  "coding_root": "/srv/salaam/owned",
  "coding_socket": "/var/run/docker.sock",
  "provider": "offline"
}
```

```sh
sal host plan --config host-config.json > host-manifest.json
chmod 600 host-manifest.json
sal host inspect --manifest host-manifest.json
sal host unit --manifest host-manifest.json --platform systemd > salaam.service
# macOS alternative:
sal host unit --manifest host-manifest.json --platform launchd > dev.salaam.host.plist
sal host run --manifest host-manifest.json
```

Planning probes the actual executor and pins its engine/profile, the exact runtime path/version, source/build/Pi digests and provider route. Review the manifest and generated native unit before installing it using the host service manager. Linux output is a user unit; use `systemctl --user` and explicitly configure login persistence if required. macOS output is a launch agent; its lifetime follows that user's launchd domain. The tooling emits configuration and supervises the daemon; it never installs/enables native units implicitly. Install and enable the reviewed unit explicitly through your OS service manager.

For Claude, put `"provider":"anthropic"`, a supported exact `model`, and `max_output_tokens` in the config, then configure `sal auth set anthropic` as the service user. Its key stays in that user's existing private credential file outside workspaces. Manifests/units contain no keys. Configure explicit budgets and review live-provider behavior before unattended use.

`host run` holds an exclusive supervisor lock separate from the daemon's state lock. It launches exactly one daemon through the pinned executable, records fsynced health/restart metadata under `STATE/host/status.json`, and uses exponential backoff capped at 30 seconds. Five short-lived daemon exits stop the supervisor for inspection. Native units restart it on failure. Daemon health and heartbeat time are both visible through `host inspect`; an old status file alone is not liveness evidence.

Stop a foreground supervisor with Ctrl+C or stop its native unit. `sal service stop` addresses only the child daemon, so supervision starts it again.

A supervisor death closes its private IPC channel; the daemon stops its owned workers and service. A replacement supervisor recovers the same journal rather than keeping an unowned worker set. SIGTERM requests orderly shutdown. The journal and its events remain the execution authority; a restart counter is not permission to retry an interrupted task. Startup checks the build/runtime and proves the exact executor before exposing operator sockets or enabling schedules. Changed source/build/engine/profile fails closed and requires a newly reviewed manifest, never an automatic retargeting of admitted jobs.

Back up service state only with a deliberate stopped-service or SQLite-aware backup procedure. Schema 11 cannot be opened by older binaries. Restore the corresponding build/runtime/profile and inspect uncertain work before explicit continuation; never delete journals or reset task state to clear an error. `jobs`, `schedules`, `inbox`, task history, actual command logs and health expose durable recovery state. A full disk or required control failure blocks fresh grants. Host status is operational metadata and does not replace those records.
