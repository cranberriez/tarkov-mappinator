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
  assert.deepEqual(markers.map((m) => [m.groups, m.tags]), [[["pmc"], ["PMC spawn"]], [["pmc", "scav"], ["PMC & Scav spawn", "Sniper"]]]);
});

test("visibility needs any of the marker's groups on", () => {
  const filters = defaultFilters("unknown");
  const shared = { layer: "extracts", groups: ["pmc", "scav"] };
  assert.equal(isVisible(shared, filters), true);
  filters.extracts.groups.pmc = false;
  assert.equal(isVisible(shared, filters), true);
  assert.equal(markerIcon(shared, filters), "extract_scav");
  filters.extracts.groups.scav = false;
  assert.equal(isVisible(shared, filters), false);
});

test("the header turns all present groups off when any is on, otherwise all on", async () => {
  const { layerState, toggleLayer } = await import("./mapLayers.ts");
  const present = ["pmc", "scav"];
  const mixed = { groups: { pmc: true, scav: false, transit: true } };
  assert.equal(layerState(mixed, present), "mixed");
  const off = toggleLayer(mixed, present);
  assert.deepEqual(off.groups, { pmc: false, scav: false, transit: true });
  assert.equal(layerState(off, present), "off");
  assert.deepEqual(toggleLayer(off, present).groups, { pmc: true, scav: true, transit: true });
});

test("role defaults hide the other faction; scavs cannot transit", () => {
  assert.equal(roleOf(null), "unknown");
  assert.equal(roleOf("Savage"), "scav");
  assert.equal(roleOf("PMC"), "pmc");
  assert.deepEqual(defaultFilters("scav").extracts.groups, { pmc: false, scav: true, transit: false });
  assert.deepEqual(defaultFilters("pmc").spawns.groups, { pmc: true, scav: false });
});

test("stored filters keep user choices and gain new layers and groups", () => {
  const merged = withDefaults({ extracts: { groups: { pmc: false } } }, "unknown");
  assert.deepEqual(merged.extracts.groups, { pmc: false, scav: true, transit: true });
  assert.deepEqual(merged.spawns.groups, { pmc: true, scav: true });
  // Saved before layers lost their own switch: a hidden layer hides its groups.
  assert.deepEqual(withDefaults({ spawns: { on: false, groups: { pmc: true } } }, "unknown").spawns.groups, { pmc: false, scav: false });
});

test("counts per layer and group", () => {
  const counts = countMarkers([{ layer: "extracts", groups: ["pmc", "scav"] }, { layer: "extracts", groups: ["transit"] }]);
  assert.deepEqual(counts, { extracts: 2, "extracts.pmc": 1, "extracts.scav": 1, "extracts.transit": 1 });
});

test("filter equality ignores key order and unknown keys", async () => {
  const { sameFilters } = await import("./mapLayers.ts");
  const a = defaultFilters("unknown");
  const b = { ...structuredClone(a), spawns: { groups: { scav: true, pmc: true } }, stale: {} };
  assert.equal(sameFilters(a, b), true);
  b.spawns.groups.pmc = false;
  assert.equal(sameFilters(a, b), false);
});

test("other layers: containers grouped by name and deduplicated, bosses merged per point, zones keep outlines", () => {
  const p = at(5, 5, 1);
  const markers = buildMarkers(map({
    lootContainers: [{ lootContainer: "c1", position: p }, { lootContainer: "c1", position: p }, { lootContainer: "c2", position: at(9, 9) }],
    bosses: [
      { mob: "bossKnight", spawnChance: 0.5, spawnLocations: [{ name: "Bunker", chance: 1, positions: [p] }] },
      { mob: "sectantPriest", spawnChance: 0.3, spawnLocations: [{ name: "Bunker", chance: 0.5, positions: [p] }] },
      { mob: "pmcUSEC", spawnChance: 1, spawnLocations: [{ name: "Road", chance: 1, positions: [at(1, 1)] }] },
    ],
    hazards: [{ id: "h", hazardType: "minefield", name: "Landmine", position: p, outline: [at(0, 0), at(1, 0), at(1, 1)] }],
    artillery: { zones: [{ id: "a", position: p, outline: [at(0, 0)], botom: 1, top: 2 }] },
    btrStops: [{ name: "Stop", x: 1, y: 2, z: 3 }],
  }), {
    containers: { c1: { name: "Safe", normalizedName: "safe" }, c2: { name: "PMC body", normalizedName: "pmc-body" } },
    mobs: { bossKnight: { name: "Knight", normalizedName: "knight" }, sectantPriest: { name: "Cultist Priest", normalizedName: "cultist-priest" } },
  });
  const by = (layer) => markers.filter((m) => m.layer === layer);
  assert.deepEqual(by("containers").map((m) => [m.groups[0], m.icon]), [["valuables", "container_safe"], ["bodies", "container_dead-scav"]]);
  const [shared, pmc] = by("bosses");
  assert.equal(shared.label, "Knight, Cultist Priest");
  assert.deepEqual(shared.tags, ["Bunker", "Knight 50%", "Cultist Priest 15%"]);
  assert.deepEqual(pmc.groups, ["pmcs"]);
  assert.deepEqual(by("hazards").map((m) => [m.groups[0], m.outline.length]), [["minefield", 3], ["artillery", 1]]);
  assert.deepEqual(by("other")[0].position, { x: 1, y: 2, z: 3 });
});

test("noisy layers and groups start hidden", () => {
  const filters = defaultFilters("unknown");
  assert.equal(filters.loose.groups.loose, false);
  assert.equal(filters.containers.groups.general, false);
  assert.equal(filters.bosses.groups.pmcs, false);
  assert.equal(defaultFilters("scav").containers.groups.valuables, true);
});
