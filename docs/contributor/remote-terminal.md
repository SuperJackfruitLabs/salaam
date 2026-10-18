# Remote terminal contributor rehearsal

The explicit rehearsal runner requires an already provisioned, operator-approved disposable host directory and uses offline fixtures:

```sh
npx --no-install tsc -p tsconfig.json
node scripts/remote-rehearsal.mjs --host APPROVED_ALIAS \
  --root /home/USER/.cache/salaam-m10.ID --report .state/evidence/m10/remote.json
```

It creates only its named fixture source, private service state and wrapper under that root, exercises real SSH PTYs plus ACP protocol coding, records identities/outcomes and stops its test service. It does not install system runtimes, copy keys or make live provider calls. This is a contributor acceptance tool.
