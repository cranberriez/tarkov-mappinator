import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarkers, defaultFilters, isVisible, layersFor, markerIcon } from "./markers.ts";
import { tarkovPreset } from "./markerPreset.ts";
import { withPosition } from "./players.ts";
import { translate } from "./translate.ts";
import { columnShifts } from "./split.ts";
import { maps } from "./catalog.ts";
import { GROUND } from "./floors.ts";
import { httpMapSource } from "./source.ts";

test("a preset with a layer of its own filters and draws markers in it", () => {
  const preset = { ...tarkovPreset, layers: [...tarkovPreset.layers,
    { key: "quests", label: "Quests", icon: "quest_item", groups: [{ key: "active", label: "Active", icon: "quest_item" }, { key: "done", label: "Done", icon: "lock", off: true }] }] };
  const filters = defaultFilters("pmc", preset);
  const active = { id: "q1", layer: "quests", groups: ["active"], position: { x: 0, y: 0, z: 0 }, tags: [] };
  const done = { ...active, id: "q2", groups: ["done"] };
  assert.equal(isVisible(active, filters, preset), true);
  assert.equal(isVisible(done, filters, preset), false);
  assert.equal(isVisible(active, defaultFilters("pmc")), false, "unknown to the default preset");
  assert.equal(markerIcon(active, filters, preset), "quest_item");
  assert.equal(markerIcon(done, filters, preset), "lock", "the first group's icon when none is shown");
  assert.ok(layersFor([active], {}, preset).some((layer) => layer.key === "quests"));
});

test("extract and transit fields are read without casts", () => {
  const [paid, transit] = buildMarkers({
    extracts: [{ id: "e", name: "Car", faction: "pmc", position: { x: 0, y: 0, z: 0 }, transferItem: { item: "5449016a4bdc2d6f028b456f", count: 7000 } }],
    transits: [{ id: "t", description: "Transit to Woods", map: "m1", conditions: "level 10", position: { x: 1, y: 0, z: 1 } }],
  }, { maps: { m1: "Woods" } });
  assert.deepEqual(paid.tags, ["Paid"]);
  assert.deepEqual(transit.details.map((row) => row.value), ["Woods", "level 10"]);
});

test("translation keys are replaced at the listed paths only", () => {
  const response = { translations: ["$.data.maps.*.name", "$.data.maps.*.extracts[*].name"],
    data: { maps: { a: { name: "K_MAP", wiki: "K_MAP", extracts: [{ name: "K_EX" }, { name: "unknown" }] } } } };
  translate(response, { K_MAP: "Customs", K_EX: "ZB-1011" });
  assert.deepEqual(response.data.maps.a, { name: "Customs", wiki: "K_MAP", extracts: [{ name: "ZB-1011" }, { name: "unknown" }] });
});

test("the HTTP source translates once per mode and finds maps by normalized name", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const body = url.endsWith("maps_en") ? { data: { K: "Customs" } }
      : { translations: ["$.data.maps.*.name"], data: { maps: { x: { id: "m1", name: "K", normalizedName: "customs" } }, lootContainers: { c: { name: "Safe", normalizedName: "safe", extra: 1 } }, stationaryWeapons: {}, mobs: {} } };
    return { ok: true, json: async () => body };
  };
  const source = httpMapSource({ host: "https://example", fetch });
  assert.equal((await source.map("customs", "pve")).name, "Customs");
  const lookups = await source.lookups("pve");
  assert.deepEqual([lookups.maps, lookups.containers], [{ m1: "Customs" }, { c: { name: "Safe", normalizedName: "safe" } }]);
  assert.deepEqual(calls, ["https://example/pve/maps", "https://example/pve/maps_en"]);
  await assert.rejects(source.map("woods", "pve"));
});

test("positions are added per track, replaced by key and kept to a limit", () => {
  const at = (key) => ({ key, x: 0, z: 0 });
  let tracks = withPosition([], "me", at("a"), { label: "Me" });
  tracks = withPosition(tracks, "me", at("b"), {}, 2);
  tracks = withPosition(tracks, "me", at("c"), {}, 2);
  tracks = withPosition(tracks, "me", at("c"), {}, 2);
  tracks = withPosition(tracks, "friend", at("a"));
  assert.deepEqual(tracks.map((track) => [track.id, track.label, track.positions.map((p) => p.key)]), [["me", "Me", ["b", "c"]], ["friend", undefined, ["a"]]]);
});

test("the ground column stays put", () => {
  assert.equal(columnShifts(maps.factory, () => 100, 10).get(GROUND), 0);
});
