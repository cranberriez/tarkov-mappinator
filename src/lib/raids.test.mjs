import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeImportedRaids, observeRaids, raidColor, raidPalette, raidStartFromId, raidStatus } from "./raids.ts";

const event = (action, logged_at) => ({ kind: "raid", action, logged_at });
const raid = (patch) => ({ id: null, lifecycle: "unknown", map: null, game_mode: null, player_role: null, started_at: null, ...patch });

test("raid starts in activity backfill placeholder raids, newest first, with ends that stop at the next start", () => {
  const activity = [
    event("started", "2026-10-11 10:00:00.000"),
    event("ended", "2026-10-11 10:30:00.000"),
    event("started", "2026-10-11 11:00:00.000"),
    event("end_reported", "2026-10-11 11:20:00.000"),
    event("started", "2026-10-11 12:00:00.000"),
  ];
  const raids = observeRaids([], undefined, activity);
  assert.deepEqual(raids.map((r) => [r.started_at.slice(11, 16), r.ended_at?.slice(11, 16) ?? null]),
    [["12:00", null], ["11:00", "11:20"], ["10:00", "10:30"]]);
});

test("the live raid replaces its backfilled placeholder and supplies map details", () => {
  const activity = [event("started", "2026-10-11 12:00:00.000")];
  const first = observeRaids([], undefined, activity);
  const live = raid({ id: "local:s:2026-10-11 12:00:00.000", lifecycle: "active", map: "Customs", game_mode: "PvE", started_at: "2026-10-11 12:00:00.000" });
  const merged = observeRaids(first, live, activity);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, live.id);
  assert.equal(merged[0].map, "Customs");
  assert.equal(raidStatus(merged[0], 0, live), "active");
});

test("remembered raids survive activity eviction and are not duplicated", () => {
  const remembered = observeRaids([], undefined, [event("started", "2026-10-11 09:00:00.000"), event("ended", "2026-10-11 09:40:00.000")]);
  const later = observeRaids(remembered, undefined, []);
  assert.equal(later.length, 1);
  assert.equal(later[0].ended_at, "2026-10-11 09:40:00.000");
  assert.equal(raidStatus(later[0], 0, undefined), "ended");
});

test("an older raid without an observed end is unknown, not active", () => {
  const raids = observeRaids([], undefined, [event("started", "2026-10-11 09:00:00.000"), event("started", "2026-10-11 10:00:00.000")]);
  assert.equal(raidStatus(raids[1], 1, undefined), "unknown");
});

test("30 pastel colours, stable per start time", () => {
  assert.equal(new Set(raidPalette).size, 30);
  assert.equal(raidColor({ started_at: "2026-10-11 12:00:00.000" }), raidColor({ started_at: "2026-10-11 12:00:00.000" }));
});

test("imported raids fill placeholders by start time and adopt the live ID scheme", () => {
  const placeholder = observeRaids([], undefined, [event("started", "2026-10-11 12:00:00.000")]);
  const merged = mergeImportedRaids(placeholder, [
    { id: "local:s:2026-10-11 12:00:00.000", session: "s", map: "Woods", game_mode: "Pve", raw_game_mode: null, started_at: "2026-10-11 12:00:00.000", ended_at: "2026-10-11 12:30:00.000" },
    { id: "local:s:2026-10-11 08:00:00.000", session: "s", map: "Customs", game_mode: null, raw_game_mode: null, started_at: "2026-10-11 08:00:00.000", ended_at: null },
  ]);
  assert.deepEqual(merged.map((r) => [r.id, r.map, r.ended_at]), [
    ["local:s:2026-10-11 12:00:00.000", "Woods", "2026-10-11 12:30:00.000"],
    ["local:s:2026-10-11 08:00:00.000", "Customs", null],
  ]);
  assert.equal(raidStartFromId("local:s:2026-10-11 08:00:00.000"), "2026-10-11 08:00:00.000");
  assert.equal(raidStartFromId("log:x"), null);
});
