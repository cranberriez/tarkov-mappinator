import assert from "node:assert/strict";
import { test } from "node:test";
import { appendPosition, freshness, mergePositions, positionsForRaid, toPlane } from "./positions.ts";

const at = (filename, observed_at, raid_id = "r1", xyz = [1, 2, 3]) => ({ filename, observed_at, raid_id, xyz });

test("repeated snapshots of the same capture do not duplicate history", () => {
  const first = at("a.png", "2026-10-11T00:00:00Z");
  const history = appendPosition(appendPosition([], first), { ...first });
  assert.equal(history.length, 1);
  assert.equal(appendPosition(history, at("b.png", "2026-10-11T00:00:05Z")).length, 2);
});

test("raid filter keeps only matching captures and treats missing ids as unassociated", () => {
  const history = [at("a", "t", "r1"), at("b", "t", null), at("c", "t", "r2")];
  assert.deepEqual(positionsForRaid(history, "r1").map((p) => p.filename), ["a"]);
  assert.deepEqual(positionsForRaid(history, null).map((p) => p.filename), ["b"]);
});

test("freshness decays linearly and clamps", () => {
  const t = Date.parse("2026-10-11T00:00:00Z");
  assert.equal(freshness("2026-10-11T00:00:00Z", t), 1);
  assert.equal(freshness("2026-10-11T00:00:00Z", t + 60_000), 0.5);
  assert.equal(freshness("2026-10-11T00:00:00Z", t + 999_999), 0);
  assert.equal(freshness("garbage", t), 0);
});

test("world Z maps to screen up", () => {
  assert.deepEqual(toPlane(at("a", "t", "r", [10, 5, 20])), { x: 10, y: -20 });
});

test("imported positions skip known files and land in capture order", () => {
  const live = { ...at("b.png", "2026-10-11T12:05:00Z"), captured_at: "2026-10-11 12:05:00" };
  const older = { ...at("a.png", "2026-10-11T12:00:00Z"), captured_at: "2026-10-11 12:00:00" };
  const merged = mergePositions([live], [older, { ...live, observed_at: "other" }]);
  assert.deepEqual(merged.map((p) => p.filename), ["a.png", "b.png"]);
  assert.equal(mergePositions(merged, [older]), merged);
});
