import assert from "node:assert/strict";
import { test } from "node:test";
import { raidColor, raidPalette, raidStartFromId, raidStatus, upsertRaids } from "./raids.ts";

const record = (id, started_at, patch = {}) => ({ id, session: "s", map: null, game_mode: null, raw_game_mode: null, started_at, ended_at: null, ...patch });
const live = (patch) => ({ id: null, lifecycle: "unknown", map: null, game_mode: null, player_role: null, started_at: null, ...patch });

test("stored rows replace by ID, newest first", () => {
  const first = upsertRaids([], [record("local:s:2026-10-11 10:00:00.000", "2026-10-11 10:00:00.000")]);
  const next = upsertRaids(first, [
    record("local:s:2026-10-11 10:00:00.000", "2026-10-11 10:00:00.000", { ended_at: "2026-10-11 10:30:00.000" }),
    record("local:s:2026-10-11 12:00:00.000", "2026-10-11 12:00:00.000"),
  ]);
  assert.deepEqual(next.map((r) => [r.started_at.slice(11, 16), r.ended_at?.slice(11, 16) ?? null]), [["12:00", null], ["10:00", "10:30"]]);
});

test("a legacy placeholder gives way to the real raid with its start time", () => {
  const placeholder = [record("log:2026-10-11 12:00:00.000", "2026-10-11 12:00:00.000")];
  const merged = upsertRaids(placeholder, [record("local:s:2026-10-11 12:00:00.000", "2026-10-11 12:00:00.000", { map: "Woods" })]);
  assert.deepEqual(merged.map((r) => [r.id, r.map]), [["local:s:2026-10-11 12:00:00.000", "Woods"]]);
});

test("only the newest raid can be active, and only while the scanner says so", () => {
  const raids = [record("b", "2026-10-11 10:00:00.000"), record("a", "2026-10-11 09:00:00.000")];
  assert.equal(raidStatus(raids[0], 0, live({ id: "b", lifecycle: "active" })), "active");
  assert.equal(raidStatus(raids[1], 1, undefined), "unknown");
  assert.equal(raidStatus({ ...raids[1], ended_at: "2026-10-11 09:40:00.000" }, 1, undefined), "ended");
});

test("30 pastel colours, stable per start time", () => {
  assert.equal(new Set(raidPalette).size, 30);
  assert.equal(raidColor({ started_at: "2026-10-11 12:00:00.000" }), raidColor({ started_at: "2026-10-11 12:00:00.000" }));
});

test("raid IDs carry their start time", () => {
  assert.equal(raidStartFromId("local:s:2026-10-11 08:00:00.000"), "2026-10-11 08:00:00.000");
  assert.equal(raidStartFromId("log:x"), null);
});
