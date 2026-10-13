# Site companion plan

Mappinator runs as a small companion that the Tarkov Hideout Tracker site
(`../tarkov-hideout-tracker`) connects to over localhost. The app watches, stores
and serves updates. The site applies them and draws the live map.

## Decisions

- **Mini-mode** is a setting or launch flag of this same app: tray icon, tiny
  status window, scanner running, full UI one click away.
- **v1 shares everything the scanner already establishes:** quest
  accepted/completed/failed, current raid (map/mode/phase), screenshot position,
  connection status.
- **Quest events auto-apply on the site as they arrive.**
- **Site map:** extend the site's existing `MapViewer` (Raid Planner) with a live
  layer. It already has projection, floors, quest objectives, extracts and
  transits. Don't port Mappinator's map. Port only Mappinator-specific behaviour
  (position marker and heading, raid-driven map selection).

## Phase 0: feasibility spike (do first)

Prove that an HTTPS page on the production domain can reach `http://127.0.0.1`:

- Chrome/Edge: Local/Private Network Access permission prompt and the
  `Access-Control-Allow-Private-Network` preflight.
- Firefox and Safari behaviour. Unknown. Decide whether unsupported browsers just
  hide the feature.
- Repeated polling doesn't re-prompt or get throttled in background tabs (if
  it is throttled, catch-up on focus is enough).

A throwaway Rust listener and a test page on a Vercel preview are enough. If
this fails, fall back to a WebSocket from the page. Only then consider a cloud
relay, which needs accounts and is out of scope.

## Companion contract (`/v1`)

Server: `127.0.0.1` on a fixed port (fallback range, advertised in the status
window). It is a separate adapter in `src-tauri`, and the scanner stays
independent of it.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/status` | app version, protocol version, scanner running, source health, latest `seq` |
| `GET /v1/sync?since=<seq>` | current state (raid, last position) plus every event after `seq`; `since=0` returns everything retained |

The site makes every request. On first connection it calls `sync?since=0` and
stores the returned `seq`. After that it polls `sync?since=<seq>`: about every
30 s when idle, and every 2–5 s while the last state is in a raid, so a new
screenshot shows up quickly. An SSE stream can be added later on the same cursor
if polling feels laggy. It is still a request the site makes, so it adds no new
connection direction.

Security: allow only the site origin(s) plus localhost dev origins. A one-time
pairing code is shown in the companion and entered on the site, and the site
stores the token. Never bind to anything other than loopback.

### Event shapes (sketch)

```ts
type CompanionEvent = { seq: number; id: string; at: string; recovered: boolean; profile?: GameMode } & (
  | { kind: "quest"; action: "accepted" | "completed" | "failed"; questId: string }
  | { kind: "raid"; phase: "loading" | "in_raid" | "ended"; map: string | null; mode: GameMode | null }
  | { kind: "position"; map: string; x: number; y: number; z: number; yaw: number | null; capturedAt: string }
);
```

- `id` is stable across restarts and replays (the scanner's dedupe key), so the
  site can apply events idempotently.
- Quest `failed` comes only from failure *notifications* with a template ID. The
  quest-failure HTTP request doesn't carry a quest ID and isn't sent.
- Inventory, hideout, mail and story requests are not sent. They only show
  intent, not an outcome.
- Map IDs: send the raw log ID and the resolved tarkov.dev `normalizedName`. The
  site maps that to its own map keys.

## Mappinator work

1. **Persistent event journal:** append-only file in the app data folder with
   monotonic `seq`. Replaces the in-memory 200-event / reset-on-restart limit
   for shared events. Prune by age or count.
2. **Companion server:** an HTTP adapter over the scanner and journal.
3. **Mini-mode:** tray icon, compact status window (connected clients, scanner
   health, pairing code), start-minimized and launch-on-login options, and the
   scanner auto-starting with saved folders. This needs settings that persist
   across restarts, which aren't implemented yet (see README).
4. Generated TS types for the contract, copied or published to the site.

## Site work

1. **Companion client:** connect/pair UI in settings, connection chip, and
   adaptive polling of `sync` (faster in raid, catch-up on tab focus), with the
   cursor stored per profile.
2. **Quest auto-apply:** route events through the existing quest-log import
   model (`src/lib/quests/quest-log-import.ts`), not new storage. Match `profile`
   to PVP/PVE/KORD. Must follow `docs/user-state.md`: inspect the store and tests
   and account for existing saves, and avoid a new persisted key if possible.
   Need an undo/notice for each applied batch.
3. **Live map:** grow the existing Raid Planner rather than rebuilding it. Add
   a `MapViewer` layer for the position marker and heading, raid map
   auto-selection, and an "in raid on X" indicator. Then port Mappinator map
   features one at a time (layers/filters, loot and item markers). If it
   outgrows the quest page, move it to its own route later.

## Open questions

- Recovered (replayed) quest events: auto-apply too, or only `recovered: false`?
  Idempotency makes either safe, but recovered history can be stale.
- Which profile to use when the raid mode is unknown (no raid seen yet).
- Should the site *write* anything back (for example, tracked quests → companion
  overlay)? Not in v1.
