import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarkers, countMarkers, defaultFilters, isVisible, markerIcon, roleOf, withDefaults } from "./mapLayers.ts";

const at = (x, z, y = 0) => ({ x, y, z });
const map = (fields) => ({ extracts: [], transits: [], spawns: [], ...fields });

test("same-named PMC and Scav extracts at one spot merge; distant ones stay apart", () => {
  const markers = buildMarkers(map({ extracts: [
    { id: "a", name: "Crossroads", faction: "pmc", position: at(0, 0) },
    { id: "b", name: "Crossroads", faction: "scav", position: at(1, 1) },
    { id: "c", name: "Trailer Park", faction: "pmc", position: at(100, 0) },
    { id: "d", name: "Trailer Park", faction: "scav", position: at(300, 0) },
  ] }));
  assert.deepEqual(markers.map((m) => [m.label, m.groups]), [
    ["Crossroads", ["pmc", "scav"]], ["Trailer Park", ["pmc"]], ["Trailer Park", ["scav"]],
  ]);
});

test("extracts without a faction are shared, and tags come from name and transfer item", () => {
  const [gate, vex, boat] = buildMarkers(map({ extracts: [
    { id: "a", name: "Gate 3", position: at(0, 0) },
    { id: "b", name: "Dorms V-Ex", faction: "pmc", position: at(50, 0), transferItem: { item: "5449016a4bdc2d6f028b456f", count: 1 } },
    { id: "c", name: "Smugglers' Boat (Flare)", faction: "pmc", position: at(90, 0), transferItem: { item: "x", count: 1 } },
  ] }));
  assert.deepEqual(gate.groups, ["pmc", "scav"]);
  assert.deepEqual(vex.tags, ["Paid"]);
  assert.deepEqual(boat.tags, ["Flare", "Item required"]);
});

test("only player spawns are kept, 'all' means both sides, duplicates collapse", () => {
  const markers = buildMarkers(map({ spawns: [
    { position: at(1, 1), sides: ["pmc"], categories: ["player"], zoneName: "z" },
    { position: at(1, 1), sides: ["pmc"], categories: ["player"], zoneName: "z" },
    { position: at(2, 2), sides: ["all"], categories: ["player", "sniper"], zoneName: "z" },
    { position: at(3, 3), sides: ["scav"], categories: ["bot", "boss"], zoneName: "z" },
    { position: at(4, 4), sides: ["none"], categories: ["player"], zoneName: "z" },
  ] }));
  assert.deepEqual(markers.map((m) => [m.groups, m.tags]), [[["pmc"], []], [["pmc", "scav"], ["Sniper"]]]);
});

test("visibility needs the layer and any of the marker's groups on", () => {
  const filters = defaultFilters("unknown");
  const shared = { layer: "extracts", groups: ["pmc", "scav"] };
  assert.equal(isVisible(shared, filters), true);
  filters.extracts.groups.pmc = false;
  assert.equal(isVisible(shared, filters), true);
  assert.equal(markerIcon(shared, filters), "extract_scav");
  filters.extracts.groups.scav = false;
  assert.equal(isVisible(shared, filters), false);
  filters.extracts.groups.scav = true;
  filters.extracts.on = false;
  assert.equal(isVisible(shared, filters), false);
});

test("role defaults hide the other faction; scavs cannot transit", () => {
  assert.equal(roleOf(null), "unknown");
  assert.equal(roleOf("Savage"), "scav");
  assert.equal(roleOf("PMC"), "pmc");
  assert.deepEqual(defaultFilters("scav").extracts.groups, { pmc: false, scav: true, transit: false });
  assert.deepEqual(defaultFilters("pmc").spawns.groups, { pmc: true, scav: false });
});

test("stored filters keep user choices and gain new layers and groups", () => {
  const merged = withDefaults({ extracts: { on: false, groups: { pmc: false } } }, "unknown");
  assert.deepEqual(merged.extracts, { on: false, groups: { pmc: false, scav: true, transit: true } });
  assert.equal(merged.spawns.on, true);
});

test("counts per layer and group", () => {
  const counts = countMarkers([{ layer: "extracts", groups: ["pmc", "scav"] }, { layer: "extracts", groups: ["transit"] }]);
  assert.deepEqual(counts, { extracts: 2, "extracts.pmc": 1, "extracts.scav": 1, "extracts.transit": 1 });
});

test("filter equality ignores key order and unknown keys", async () => {
  const { sameFilters } = await import("./mapLayers.ts");
  const a = defaultFilters("unknown");
  const b = { spawns: { groups: { scav: true, pmc: true }, on: true }, extracts: { ...a.extracts }, stale: {} };
  assert.equal(sameFilters(a, b), true);
  b.spawns.groups.pmc = false;
  assert.equal(sameFilters(a, b), false);
});
