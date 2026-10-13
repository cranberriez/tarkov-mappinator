import assert from "node:assert/strict";
import { test } from "node:test";
import { splitFloors } from "./split.ts";

const ground = { x1: 0, y1: 0, x2: 100, y2: 100 };
const box = (layer, x1, y1, x2, y2) => ({ layer, x1, y1, x2, y2 });
const options = { gap: 2, join: 1 };

test("a building's floors leave by the nearest edge, low to high reading left to right", () => {
  const slots = splitFloors(ground, [box("f2", 80, 10, 90, 20), box("f3", 82, 12, 88, 18), box("u", 10, 50, 20, 60)], ["u", "f2", "f3"], options);
  const at = (layer) => slots.find((slot) => slot.layer === layer);
  assert.equal(at("f2").x1 + at("f2").dx, 102);
  assert.equal(at("f3").x1 + at("f3").dx, 114);
  assert.equal(at("u").x2 + at("u").dx, -2);
});

test("a left-side building puts its lowest floor outermost", () => {
  const slots = splitFloors(ground, [box("f2", 10, 10, 20, 20), box("f3", 10, 10, 20, 20)], ["f2", "f3"], options);
  const at = (layer) => slots.find((slot) => slot.layer === layer);
  assert.equal(at("f3").x2 + at("f3").dx, -2);
  assert.equal(at("f2").x2 + at("f2").dx, -14);
});

test("rows that share a height wait for each other, others do not", () => {
  const slots = splitFloors(ground, [box("f2", 90, 10, 95, 20), box("f2", 70, 12, 75, 18), box("f2", 70, 60, 75, 70)], ["f2"], options);
  const moved = slots.map((slot) => slot.x1 + slot.dx).sort((a, b) => a - b);
  assert.deepEqual(moved, [102, 102, 109]);
});

test("touching pieces are one building", () => {
  const slots = splitFloors(ground, [box("f2", 80, 10, 85, 20), box("f2", 86, 10, 90, 20)], ["f2"], options);
  assert.equal(slots.length, 1);
});

import { columnShifts } from "./split.ts";
import { maps } from "./catalog.ts";

test("icebreaker decks line up low to high around the one that is the base", () => {
  const map = maps.icebreaker;
  const shifts = columnShifts(map, () => 100, 10);
  const base = map.layers.find((floor) => floor.tilePath === map.tilePath);
  assert.equal(shifts.get(base.name), 0);
  assert.ok(shifts.get("Control Room") < shifts.get("Engine Room"));
  assert.ok(shifts.get("Bridge Roof") > shifts.get("Bridge"));
  assert.equal(new Set(shifts.values()).size, map.layers.length);
});

test("a map with ground keeps it put, underground to its left and upper floors to its right", () => {
  const shifts = columnShifts(maps.factory, () => 100, 10);
  assert.deepEqual([shifts.get("Tunnels"), shifts.get("2nd Floor"), shifts.get("3rd Floor")], [-110, 110, 220]);
});
