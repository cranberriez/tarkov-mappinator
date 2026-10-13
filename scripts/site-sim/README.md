# Site simulator

Acts like the Tarkov Hideout site against the companion's real `/v1` HTTP contract, so the app's
connection states can be exercised without the site. Node 22+, no dependencies. The app never imports,
bundles or compiles it.

Enable **Settings → Site connection** in the app first.

```powershell
node scripts/site-sim/site-sim.mjs pair      # request pairing; click Allow or Deny in the app
node scripts/site-sim/site-sim.mjs poll      # adaptive sync polling with cursor resume
node scripts/site-sim/site-sim.mjs status    # one-off /v1/status (add --no-token for the unpaired view)
node scripts/site-sim/site-sim.mjs checks    # negative cases, PASS/FAIL per line
```

Options: `--origin <url>` (default `http://localhost:3000`; must be on the app's allowlist), `--port <n>`.
`poll` takes `--interval <s>` (idle, default 30), `--raid-interval <s>` (in raid, default 3),
`--stop-after <s>` and `--since <seq>`.

The token, port, cursor and epoch are saved per origin in `.site-sim.json` next to this file (gitignored).

## Exercising each state

| State | How |
| --- | --- |
| waiting | Enable the connection; don't poll (or revoke every client). |
| connected | `poll` |
| stale | `poll --stop-after 10`, then wait out the app's threshold (150 s). |
| error | Occupy ports 47615–47619 before enabling, e.g. run the spike or another listener on each. |
| revoked | Revoke the client in the app; `poll` exits with `invalid_token`, and `checks --expect-revoked` passes. |

## Limits

It can't reproduce browser-only behaviour: Chrome/Edge Local Network Access prompts, CORS enforcement,
or background-tab timer throttling. The Phase 0 spike (`src-tauri/examples/lna_spike.rs`) covers those.
