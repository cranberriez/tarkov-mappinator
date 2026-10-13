# Site Sync page spec

Step 2 of [site-companion-plan.md](site-companion-plan.md): the site's side of the companion. A new
`/sync` page for setup and status. Quest events auto-apply in the background. Nothing on the Raid
Planner changes, and the download section is a placeholder.

## Phase 0 result

Passed (2026-10-13): with the spike (`src-tauri/examples/lna_spike.rs`), Chrome/Edge reach the
loopback listener from a public-address-space page after the Local Network Access prompt, and
polling behaves as the plan expects.

## Direction of data

The site only reads events from Mappinator (`GET /v1/sync`). It sends no progress during the
handshake. Its cursor (`epoch`, `seq`) is all it needs to tell the app. Progress from site to app is
step 3 (`POST /v1/progress`, a copy the app never edits), not part of this page.

## Game mode rule

Every event that changes progress must name its game mode, and the site never infers one.

- Map `mode` → profile by exact match only: `regular` → PVP, `pve` → PVE, `pvp-season` → KORD (the
  currently selected seasonal character). Do **not** use `parseGameMode`/`fromTarkovJsonGameMode`: both
  fall back to PVP.
- `mode: null` or unrecognised → the event is never applied. Count it on the Sync page as
  "N events with unknown mode", with no apply action.
- Mappinator stamps each activity event with the mode in effect when it was logged: the latest
  `Session mode:` record at or before it in the same log session (the mode can change mid-session).
  Stored in `activity.game_mode` (history schema v2); no preceding record → `null`.

## Page: `/sync`

Listed in the secondary (☰) menu next to Settings. Flat layout, top to bottom:

1. **Connection.** One status line: Not set up / Waiting for Mappinator / Connected (last sync Xs ago) /
   App not running / Access revoked. Buttons: Connect, Disconnect.
2. **Pairing (only while connecting).** Scan ports 47615–47619 with `GET /v1/status` and pick the
   first `app: "tarkov-mappinator"`. Then `POST /v1/pair` and poll the pairing until the user clicks
   Allow in the app. Show "Approve in Mappinator" plus a countdown (`expires_in_secs`). Denied, expired
   and blocked-by-browser (LNA declined) each get their own message.
3. **Activity.** Recently applied batches, per profile: "PVE · completed 2 quests · 14:02 · Undo".
   Below that: pending counts for profiles that aren't active, unknown-mode count, and the
   recovered-events review (see below).
4. **Download.** Placeholder heading and one line of text. No link yet.

A small connection chip in the navbar (only when paired) links to `/sync`.

## Polling

As in the plan: `sync?since=<seq>` every 30 s when idle, every 3 s while `state.raid.phase` is
`loading`/`in_raid`, and immediately when the tab regains focus. A new `epoch` or `since > seq` resets the
cursor to 0. Ids already applied are skipped (below). Lives in a single client controller mounted
in the `(data)` layout so it runs on every page, not only `/sync`.

## Applying quest events

- `completed` → `applyQuestCompletionChange({ complete })`; `failed` → `applyQuestFailureChange({ fail })`.
  No prerequisite backfill in v1. The file import already does that, with sensitive-quest prompts.
- `accepted` → not applied (the store has no accepted state). Kept for later availability hints.
- Quest IDs that aren't in the profile's quest catalog are skipped and counted, not stored.
- **Active profile matches the mode:** apply right away in one batch, with a toast: "Mappinator: completed 2 PVE
  quests · Undo". Undo reverses only the IDs that batch changed.
- **Mode belongs to a profile that isn't active:** log it in the Sync page activity under that
  profile ("PVE · completed 2 quests · waiting for PVE") and queue it. It applies when that profile
  becomes active, with the same toast, and the log entry updates to applied. Store actions only write
  the active profile, and the file import switches the active mode to apply, which a background sync
  must never do.
- **`recovered: true`:** don't auto-apply. Show it under Activity as "Found in logs: 3 PVE
  completions · Apply / Dismiss". Recovered history may be stale or already undone by the user.

## Persistence

One new key, `tarkov-companion-sync-v1`, owned by a new store (not `useUserStore`):

```ts
{
  version: 1,
  connection: { origin: string; port: number; token: string; pairedAt: string } | null,
  cursor: { epoch: string; seq: number } | null,
  // Per profile key (PVP, PVE, KORD:season-x): ids applied or dismissed, newest 2000.
  handled: Record<string, string[]>,
  // Batches waiting for that profile to become active.
  pending: Record<string, { id: string; at: string; action: "completed" | "failed"; questId: string }[]>,
}
```

- Not in backups. Delete ALL data leaves it alone (like the import seen-files key). Disconnect clears
  `connection`, `cursor` and `pending`, and keeps `handled` so re-pairing doesn't re-apply old events.
- Undo marks the ids as handled, so a later replay doesn't redo them.
- `docs/user-state.md` gets a row for the key.

## Out of scope

Raid/position display (live map), site → app progress, the download link, prerequisite backfill,
and support for browsers other than Chrome/Edge (other browsers see "Not supported in this browser"
if Phase 0 shows they can't connect).

## Decisions

1. KORD events (`pvp-season`) target the current season's character. They're queued like an inactive
   profile while a past season's character is selected, so live events never land on an old
   seasonal save. Queue key is `KORD:<current season id>`.

## Open questions

1. (Superseded by decision 1.) KORD events while the selected seasonal character is a past season: apply to the selected
   character, or hold until the current season's character is selected?
