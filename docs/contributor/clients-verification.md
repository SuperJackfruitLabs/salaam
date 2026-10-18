# Clients contributor notes

## Demonstrate and verify

```sh
npm run demo:acceptance
npm run test:acceptance
# Faster development run; explicitly recorded as partial acceptance:
npm run test:acceptance -- --repeats 1
```

The combined demo starts disposable offline service/effect fixtures, submits from the installed terminal, kills that client with two pending approvals, loads the same session over ACP, approves one effect, recovers child results, performs three checkpoints and retrieves old evidence. It inspects the same final session through the installed CLI.

The acceptance runner records source-file hashes, worker bundle digest, runtime/platform, command exit codes, log digests, JSON reports and all six proof suites repeated 20 times by default. Reports live under `.state/evidence/acceptance/RUN_ID/`; `latest-acceptance.json` points to the last successful run. A shorter repetition run is marked partial. CI retains separate macOS and Linux artifacts. Platform success means an observed passing run for that revision; it does not imply a deployment, SSH rehearsal, live-model behavior evaluation or production isolation.
