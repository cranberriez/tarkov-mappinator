import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarkers, countMarkers, defaultFilters, groupOn, isVisible, layersFor, markerIcon, roleOf, withDefaults } from "./markers.ts";

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
  const { layerState, toggleLayer } = await import("./markers.ts");
  const present = ["pmc", "scav"];
  const mixed = { groups: { pmc: true, scav: false, transit: true } };
  assert.equal(layerState(mixed, present, "extracts"), "mixed");
  const off = toggleLayer(mixed, present, "extracts");
  assert.deepEqual(off.groups, { pmc: false, scav: false, transit: true });
  assert.equal(layerState(off, present, "extracts"), "off");
  assert.deepEqual(toggleLayer(off, present, "extracts").groups, { pmc: true, scav: true, transit: true });
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
  const { sameFilters } = await import("./markers.ts");
  const a = defaultFilters("unknown");
  const b = { ...structuredClone(a), spawns: { groups: { scav: true, pmc: true } }, stale: {} };
  assert.equal(sameFilters(a, b), true);
  b.spawns.groups.pmc = false;
  assert.equal(sameFilters(a, b), false);
});

test("other layers: containers keyed by type and deduplicated, bosses merged per point, zones keep outlines", () => {
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
    mobs: { bossKnight: { name: "Knight", normalizedName: "knight", imagePortraitLink: "https://assets.tarkov.dev/knight-portrait.webp" }, sectantPriest: { name: "Cultist Priest", normalizedName: "cultist-priest" } },
  });
  const by = (layer) => markers.filter((m) => m.layer === layer);
  assert.deepEqual(by("containers").map((m) => [m.groups[0], m.icon]), [["safe", "container_safe"], ["pmc-body", "container_dead-scav"]]);
  const [shared, pmc] = by("bosses");
  assert.equal(shared.label, "Knight, Cultist Priest");
  assert.deepEqual(shared.tags, ["Bunker", "Knight 50%", "Cultist Priest 15%"]);
  assert.deepEqual(shared.groups, ["knight", "cultist-priest"]);
  const [knight, priest] = shared.bosses;
  assert.deepEqual([knight.name, knight.image, knight.chance, knight.raidChance, knight.location, knight.entries], ["Knight", "https://assets.tarkov.dev/knight-portrait.webp", 0.5, 0.5, "Bunker", 1]);
  assert.ok(Math.abs(priest.chance - 0.15) < 1e-9);
  assert.deepEqual([priest.raidChance, priest.icon], [0.3, "spawn_cultist-priest"]);
  assert.deepEqual(pmc.groups, ["pmcs"]);
  assert.deepEqual(by("hazards").map((m) => [m.groups[0], m.outline.length]), [["minefield", 3], ["artillery", 1]]);
  assert.deepEqual(by("other")[0].position, { x: 1, y: 2, z: 3 });
});

test("noisy layers and groups start hidden", () => {
  const filters = defaultFilters("unknown");
  assert.equal(filters.loose.groups.loose, false);
  assert.equal(groupOn(filters.bosses, "pmcs", "bosses"), false);
  assert.equal(groupOn(filters.bosses, "raider", "bosses"), false);
  assert.equal(groupOn(filters.bosses, "killa", "bosses"), true);
});

test("lock and extract details: key, power, faction, roubles, switch names", () => {
  const markers = buildMarkers(map({
    locks: [{ id: "l", lockType: "trunk", key: "k1", needsPower: true, position: at(0, 0) }],
    switches: [{ id: "s1", name: "Power Switch", switchType: "Open", activatedBy: false, activates: [], position: at(5, 5) }],
    extracts: [
      { id: "a", name: "Gate", faction: "pmc", position: at(10, 0), switches: ["s1"], transferItem: { item: "5449016a4bdc2d6f028b456f", count: 5000 } },
      { id: "b", name: "Gate", faction: "scav", position: at(11, 0) },
      { id: "c", name: "Boat", faction: "pmc", position: at(90, 0), transferItem: { item: "x", count: 2 } },
    ],
  }), { maps: {} });
  const by = (prefix) => markers.find((m) => m.id.startsWith(prefix));
  assert.deepEqual(by("lock:").details, [{ label: "Type", value: "Trunk" }, { label: "Key", items: [{ id: "k1" }] }, { label: "Needs power", value: "Yes" }]);
  assert.deepEqual(by("extract:a").details, [{ label: "Faction", value: "Shared" }, { label: "Requires", value: "5,000 ₽" }, { label: "Switch", value: "Power Switch", mono: false }]);
  assert.deepEqual(by("extract:c").details[1], { label: "Requires", items: [{ id: "x", count: 2 }] });
  assert.deepEqual(by("switch:").details, [{ label: "Type", value: "Open" }, { label: "Opens", value: "Gate" }]);
});

test("boss types: one group each, same-type entries merged, defaults for unknown groups", () => {
  const p = at(5, 5);
  const mobs = { bossBully: { name: "Reshala", normalizedName: "reshala" }, pmcBEAR: { name: "BEAR", normalizedName: "bear" }, pmcUSEC: { name: "USEC", normalizedName: "usec" }, followerBully: { name: "Guard", normalizedName: "guard" }, exUsec: { name: "Rogue", normalizedName: "rogue" } };
  const location = (chance) => [{ name: "Dorms", chance, positions: [p] }];
  const markers = buildMarkers(map({ bosses: [
    { mob: "bossBully", spawnChance: 1, spawnLocations: location(0.5), escorts: [{ mob: "followerBully", amount: [{ chance: 1, count: 2 }] }], spawnTime: 90, spawnTrigger: "Always" },
    { mob: "bossBully", spawnChance: 0.8, spawnLocations: location(0.5), escorts: [{ mob: "followerBully", amount: [{ chance: 1, count: 2 }] }] },
    { mob: "pmcBEAR", spawnChance: 1, spawnLocations: location(1) }, { mob: "pmcUSEC", spawnChance: 1, spawnLocations: location(1) },
    { mob: "exUsec", spawnChance: 1, spawnLocations: location(1) },
  ] }), { mobs });
  const [marker] = markers.filter((m) => m.layer === "bosses");
  assert.deepEqual(marker.groups, ["reshala", "pmcs", "rogue"]);
  const [reshala, pmcs] = marker.bosses;
  assert.equal(reshala.entries, 2);
  assert.equal(reshala.raidChance, undefined);
  assert.ok(Math.abs(reshala.chance - (1 - 0.5 * 0.6)) < 1e-9);
  assert.deepEqual(reshala.escorts, [{ name: "Guard", count: "2" }]);
  assert.deepEqual([reshala.spawnTime, reshala.trigger], ["1:30", "Always"]);
  assert.deepEqual([pmcs.name, pmcs.entries, pmcs.image], ["PMC bots", 2, undefined]);
  const defs = layersFor(markers).find((layer) => layer.key === "bosses").groups;
  assert.deepEqual(defs.map((g) => [g.key, !!g.off]), [["reshala", false], ["pmcs", true], ["rogue", true]]);
  // Only the default-on type shows; toggling another type on switches the marker's icon over.
  const filters = defaultFilters("unknown");
  assert.equal(markerIcon(marker, filters), "spawn_boss");
  filters.bosses.groups.reshala = false;
  assert.equal(isVisible(marker, filters), false);
  filters.bosses.groups.rogue = true;
  assert.equal(markerIcon(marker, filters), "spawn_rogue");
});

test("filter equality treats missing boss types as defaults and ignores old boss keys", async () => {
  const { sameFilters } = await import("./markers.ts");
  const a = defaultFilters("unknown");
  const b = structuredClone(a);
  b.bosses.groups = { killa: true, raiders: false, bosses: false };
  assert.equal(sameFilters(a, b), true);
  b.bosses.groups.killa = false;
  assert.equal(sameFilters(a, b), false);
  assert.deepEqual(withDefaults({ bosses: { groups: { bosses: false, raiders: true, killa: false } } }, "unknown").bosses.groups, { killa: false });
});

test("container types: one group each under a category, categories off by default decide the type's default", async () => {
  const { sameFilters, layerState, toggleLayer } = await import("./markers.ts");
  const markers = buildMarkers(map({ lootContainers: [
    { lootContainer: "c1", position: at(1, 1) }, { lootContainer: "c2", position: at(2, 2) }, { lootContainer: "c3", position: at(3, 3) },
    { lootContainer: "c4", position: at(4, 4) }, { lootContainer: "unknown-id", position: at(5, 5) },
  ] }), { containers: {
    c1: { name: "Safe", normalizedName: "safe" }, c2: { name: "Jacket", normalizedName: "jacket" },
    c3: { name: "Dead Scav", normalizedName: "dead-scav" }, c4: { name: "Drawer", normalizedName: "drawer" },
  } });
  assert.deepEqual(markers.map((m) => m.groups), [["safe"], ["jacket"], ["dead-scav"], ["drawer"], ["unknown-id"]]);
  assert.equal(countMarkers(markers)["containers.safe"], 1);
  const defs = layersFor(markers).find((layer) => layer.key === "containers").groups;
  assert.deepEqual(defs.map((g) => [g.key, g.label, g.parent, !!g.off]), [
    ["jacket", "Jacket", "valuables", false], ["safe", "Safe", "valuables", false],
    ["dead-scav", "Dead Scav", "bodies", true], ["drawer", "Drawer", "general", true], ["unknown-id", "unknown-id", "general", true],
  ]);
  assert.equal(defs.find((g) => g.key === "safe").icon, "container_safe");
  const filters = defaultFilters("unknown");
  const [safe, jacket, scav] = markers;
  assert.deepEqual([isVisible(safe, filters), isVisible(scav, filters), isVisible(markers[3], filters)], [true, false, false]);
  // Switching one type leaves its category mixed; the category click then turns the rest off, and again turns all on.
  filters.containers.groups.jacket = false;
  const valuables = ["safe", "jacket"];
  assert.equal(layerState(filters.containers, valuables, "containers"), "mixed");
  assert.equal(isVisible(jacket, filters), false);
  assert.equal(isVisible(safe, filters), true);
  const off = toggleLayer(filters.containers, valuables, "containers");
  assert.deepEqual([off.groups.safe, off.groups.jacket], [false, false]);
  assert.deepEqual([toggleLayer(off, valuables, "containers").groups.safe, groupOn(off, "dead-scav", "containers")], [true, false]);
  filters.containers.groups["dead-scav"] = true;
  assert.equal(isVisible(scav, filters), true);
});

test("old container category keys are dropped and ignored by filter equality", async () => {
  const { sameFilters } = await import("./markers.ts");
  assert.deepEqual(withDefaults({ containers: { groups: { valuables: false, general: true, safe: false } } }, "unknown").containers.groups, { safe: false });
  const a = defaultFilters("unknown");
  const b = structuredClone(a);
  b.containers.groups = { valuables: false, general: true, safe: true, drawer: false };
  assert.equal(sameFilters(a, b), true);
  b.containers.groups.drawer = true;
  assert.equal(sameFilters(a, b), false);
});

test("loose loot: one group per item category under its top level, uncategorised spawns last, all off by default", () => {
  const looseCategories = {
    "barter-items": { label: "Barter items", icon: "https://assets.tarkov.dev/b.webp" },
    valuables: { label: "Valuables", icon: "https://assets.tarkov.dev/v.webp", parent: "barter-items" },
    posters: { label: "Posters", icon: "item:p", parent: "barter-items" },
    "info-items": { label: "Info items", icon: null },
  };
  const markers = buildMarkers(map({ looseCategories, lootLoose: [
    { position: at(1, 1), items: ["gold", "poster"], categories: ["valuables", "posters"] },
    { position: at(2, 2), items: ["ssd"], categories: ["info-items"] },
    { position: at(3, 3), items: ["unknown"], categories: [] },
  ] }));
  assert.deepEqual(markers.map((m) => m.groups), [["valuables", "posters"], ["info-items"], ["loose"]]);
  assert.deepEqual(markers[0].details[0], { label: "Categories", value: "Valuables, Posters" });
  const layer = layersFor(markers, looseCategories).find((l) => l.key === "loose");
  assert.deepEqual(layer.categories.map((c) => [c.key, c.label]), [["barter-items", "Barter items"], ["info-items", "Info items"], ["loose", "Uncategorised"]]);
  assert.deepEqual(layer.groups.map((g) => [g.key, g.parent, g.icon]), [
    ["info-items", "info-items", "loose_loot"], ["posters", "barter-items", "item:p"],
    ["valuables", "barter-items", "https://assets.tarkov.dev/v.webp"], ["loose", "loose", "loose_loot"],
  ]);
  const filters = defaultFilters("unknown");
  assert.equal(markers.some((m) => isVisible(m, filters)), false);
  filters.loose.groups.posters = true;
  assert.deepEqual(markers.map((m) => isVisible(m, filters)), [true, false, false]);
  // Without categories (item enrichment off) the layer keeps its single plain group.
  const plain = buildMarkers(map({ lootLoose: [{ position: at(1, 1), items: ["x"] }] }));
  assert.deepEqual(plain[0].groups, ["loose"]);
  assert.equal(layersFor(plain).find((l) => l.key === "loose").categories, undefined);
});

test("document locations attach to the spawn under them; hand-placed ones elsewhere get their own marker", () => {
  const project = "6a3181f178450ec91c0ea1aa";
  const location = (id, x, z, match = "auto") => ({ id, maps: ["customs"], type: "project", title: id, position: { x, z }, match });
  const markers = buildMarkers(map({ lootLoose: [{ position: at(10, 20), items: [project] }, { position: at(-40, 5), items: [project] }] }), {}, undefined, [
    location("stale", 10.2, 20.1), location("linked", 10, 20, "manual"), location("placed", 100, 100, "manual"), { id: "loose", maps: ["customs"], type: "project", title: "loose" },
  ]);
  const documents = markers.filter((marker) => marker.layer === "documents");
  assert.deepEqual(documents.map((marker) => [marker.id, marker.document?.id]),
    [["document:0", "linked"], ["document:1", undefined], ["document:placed", "placed"]]);
});

test("a spawn that can hold two document types gets a marker per type, each with its own location", () => {
  const [financial, project] = ["6a31807f17005505b70d5827", "6a3181f178450ec91c0ea1aa"];
  const location = (id, type) => ({ id, maps: ["customs"], type, title: id, position: { x: 1, z: 2 }, match: "manual" });
  const markers = buildMarkers(map({ lootLoose: [{ position: at(1, 2), items: [financial, project] }] }), {}, undefined,
    [location("shelf", "financial"), location("desk", "project")]).filter((marker) => marker.layer === "documents");
  assert.deepEqual(markers.map((marker) => [marker.id, marker.groups, marker.document?.id, marker.slot]), [
    ["document:0:financial", ["financial"], "shelf", { index: 0, of: 2 }],
    ["document:0:project", ["project"], "desk", { index: 1, of: 2 }],
  ]);
});
