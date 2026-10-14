import assert from "node:assert/strict";
import { test } from "node:test";
import { artRect, metricProjection, projectionFor } from "./projection.ts";
import { AREA_MARGIN, floorAt, floorOf, floorOrder, floorsOf, GROUND } from "./floors.ts";
import { games, mapName, maps, resolveGame, resolveMap } from "./catalog.ts";
import { tileCount, tileRange, tilesIn, tileZoom } from "./tiles.ts";

const close = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≉ ${expected}`);

// Reference: tarkov.dev's Leaflet CRS — rotate (x, z) by coordinateRotation, then
// Transformation(t0, t1, -t2, t3) at zoom 0.
function leaflet(map, x, z) {
  const r = (map.coordinateRotation * Math.PI) / 180;
  const X = x * Math.cos(r) - z * Math.sin(r), Y = x * Math.sin(r) + z * Math.cos(r);
  return { x: map.transform[0] * X + map.transform[1], y: -map.transform[2] * Y + map.transform[3] };
}

test("projection matches tarkov.dev's CRS for every calibrated map", () => {
  for (const map of Object.values(maps)) {
    const projection = projectionFor(map);
    for (const [x, z] of [[0, 0], [123.4, -56.7], [-300, 250]]) {
      const actual = projection.toPlane({ x, z }), expected = leaflet(map, x, z);
      close(actual.x, expected.x);
      close(actual.y, expected.y);
    }
  }
});

test("toWorld undoes toPlane for every calibrated map and the metric plane", () => {
  for (const projection of [...Object.values(maps).map((map) => projectionFor(map)), metricProjection]) {
    for (const [x, z] of [[0, 0], [123.4, -56.7], [-300, 250]]) {
      const back = projection.toWorld(projection.toPlane({ x, z }));
      close(back.x, x, 1e-6);
      close(back.z, z, 1e-6);
    }
  }
});

test("art rectangle spans both projected corners of the SVG bounds", () => {
  const customs = maps.customs;
  const projection = projectionFor(customs);
  const rect = artRect(customs);
  const [a, b] = customs.bounds.map(([x, z]) => projection.toPlane({ x, z }));
  close(rect.x, Math.min(a.x, b.x));
  close(rect.y, Math.min(a.y, b.y));
  close(rect.width, Math.abs(a.x - b.x));
  close(rect.height, Math.abs(a.y - b.y));
});

test("heading follows the projected forward direction, for any rotation", () => {
  close(metricProjection.heading(90), 90);
  for (const coordinateRotation of [0, 90, 180, 270]) {
    const projection = projectionFor({ transform: [0.5, 10, 0.5, 20], coordinateRotation });
    for (const heading of [0, 45, 90, 200]) {
      const step = (Math.PI * heading) / 180;
      const from = projection.toPlane({ x: 0, z: 0 });
      const to = projection.toPlane({ x: Math.sin(step), z: Math.cos(step) });
      const expected = ((Math.atan2(to.x - from.x, from.y - to.y) * 180) / Math.PI + 360) % 360;
      close(projection.heading(heading), expected, 1e-6);
    }
  }
  // 180° maps (most of them): world +Z points down the plane.
  close(projectionFor(maps.customs).heading(0), 180, 1e-9);
});

test("floors match by height and optional area", () => {
  const customs = maps.customs;
  const dorms = { x: 200, z: 150 };
  assert.equal(floorAt(customs, { ...dorms, y: 1 }).id, GROUND);
  assert.equal(floorAt(customs, { ...dorms, y: 4 }).svgLayer, "Second_Floor");
  assert.equal(floorAt(customs, { x: -340, z: 200, y: 4 }).id, GROUND, "outside every 2nd-floor area");
  assert.equal(floorAt(customs, dorms).id, GROUND, "no height, base floor");
});

test("floors match areas as drawn, just outside them only where no area holds the point", () => {
  const square = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  const map = { ...maps.customs, key: "test", layers: [
    { name: "2nd Floor", show: true, extents: [{ height: [3, 10000], areas: [square] }] },
    { name: "3rd Floor", show: true, extents: [{ height: [3, 10000], areas: [[[[10.5, 0], [20, 0], [20, 10], [10.5, 10]]]] }] },
  ] };
  assert.equal(floorAt(map, { x: 5, z: 5, y: 4 }).id, "2nd Floor");
  assert.equal(floorAt(map, { x: 5, z: 5, y: 2 }).id, GROUND, "below the floor");
  assert.equal(floorAt(map, { x: 5, z: -AREA_MARGIN / 2, y: 4 }).id, "2nd Floor", "just outside the edge");
  assert.equal(floorAt(map, { x: 5, z: -AREA_MARGIN * 2, y: 4 }).id, GROUND, "beyond the margin");
  assert.equal(floorAt(map, { x: 9.9, z: 5, y: 4 }).id, "2nd Floor", "inside one area beats the margin of the next");
  assert.equal(floorOf(map, { position: { x: 5, z: 5, y: 4 }, floor: "3rd Floor" }).id, "3rd Floor", "set by hand");
  assert.equal(floorOf(map, { position: { x: 5, z: 5, y: 4 }, floor: "nowhere" }).id, "2nd Floor", "unknown hand floor");
});

test("a map with rooms takes floors from them alone: outline and heights, both ends in, else the ground", () => {
  const rooms = [
    { floor: "2nd Floor", zone: "block", height: [4.7, 7.6], rect: { x: 0, z: 0, width: 20, depth: 10, angle: 0 } },
    { floor: "3rd Floor", zone: "block", height: [7.6, null], rect: { x: 0, z: 0, width: 20, depth: 10, angle: 0 } },
    // Turned 45°: its corner reaches past an unturned box of the same size.
    { floor: "2nd Floor", zone: "tilted", height: [3, 6], rect: { x: 100, z: 0, width: 10, depth: 10, angle: 45 } },
  ];
  // tarkov.dev's extents would put y 12 anywhere on the 2nd floor; with rooms they no longer count.
  const map = { ...maps.customs, key: "test", rooms };
  assert.equal(floorAt(map, { x: 0, z: 0, y: 5 }).id, "2nd Floor");
  assert.equal(floorAt(map, { x: 0, z: 0, y: 4.7 }).id, "2nd Floor", "bottom included");
  assert.equal(floorAt(map, { x: 0, z: 0, y: 4.66 }).id, "2nd Floor", "to the tenth");
  assert.equal(floorAt(map, { x: 0, z: 0, y: 7.6 }).id, "3rd Floor", "a shared height goes up");
  assert.equal(floorAt(map, { x: 0, z: 0, y: 3 }).id, GROUND, "in a room, below its heights");
  assert.equal(floorAt(map, { x: 50, z: 0, y: 5 }).id, GROUND, "outside every room");
  assert.equal(floorAt(map, { x: 100, z: 6.5, y: 4 }).id, "2nd Floor", "inside the turned room's corner");
  assert.equal(floorAt(map, { x: 104, z: 4, y: 4 }).id, GROUND, "inside the unturned box, outside the turned room");
  assert.equal(floorAt(map, { x: 0, z: 0 }).id, GROUND, "no height");
});

test("every map has one base floor, listed first, and floor ids are unique", () => {
  for (const [key, map] of Object.entries(maps)) {
    const floors = floorsOf(map);
    assert.equal(floors.filter((floor) => floor.base).length, 1, key);
    assert.ok(floors[0].base, key);
    assert.equal(new Set(floors.map((floor) => floor.id)).size, floors.length, key);
    assert.ok(!map.layers.some((layer) => layer.name === GROUND), `${key} lists a floor named "${GROUND}"`);
  }
});

test("a listed floor drawn by the base art is the base floor, with no separate ground", () => {
  const floors = floorsOf(maps.icebreaker);
  assert.equal(floors[0].id, "Infirmary");
  assert.equal(floors.length, maps.icebreaker.layers.length);
  assert.deepEqual([floorsOf(maps.customs)[0].id, floorsOf(maps.customs)[0].name], [GROUND, "Ground Level"]);
});

// Identifiers observed in real game logs: `Location:` ids and scene bundles.
const observed = {
  bigmap: "customs", customs_preset: "customs", factory4_day: "factory", factory_day_preset: "factory",
  factory4_night: "night-factory", factory_night_preset: "night-factory", TarkovStreets: "streets-of-tarkov",
  city_preset: "streets-of-tarkov", Sandbox: "ground-zero", sandbox_preset: "ground-zero", Sandbox_high: "ground-zero-21",
  sandbox_high_preset: "ground-zero-21", Lighthouse: "lighthouse", lighthouse_preset: "lighthouse", Shoreline: "shoreline",
  shoreline_preset: "shoreline", Woods: "woods", woods_preset: "woods", Interchange: "interchange", shopping_mall: "interchange",
  Icebreaker: "icebreaker", icebreaker: "icebreaker",
};

test("every identifier seen in game logs resolves to its game map", () => {
  for (const [id, key] of Object.entries(observed)) assert.equal(resolveGame(id)?.key, key, id);
  assert.equal(resolveGame("maps/customs_preset.bundle")?.key, "customs");
  assert.equal(resolveGame("Customs")?.key, "customs", "legacy display names in stored history");
  assert.equal(mapName("city_preset"), "Streets of Tarkov");
  assert.equal(mapName("something_new"), "something_new");
  assert.equal(resolveGame(null), null);
});

test("game maps share art where tarkov.dev does", () => {
  assert.equal(resolveMap("factory4_night")?.key, "factory");
  assert.equal(resolveMap("Sandbox_high")?.key, "ground-zero");
  assert.equal(resolveMap("laboratory_dark")?.key, "the-lab");
  assert.equal(resolveMap("laboratory")?.svg, undefined, "Labs is tiles only");
  assert.ok(resolveMap("laboratory")?.tilePath);
  assert.equal(resolveMap("Sandbox_start"), null);
  for (const game of games) if (game.art) assert.ok(maps[game.art], game.key);
});

test("tiles cover the map bounds and follow the view zoom", () => {
  const customs = maps.customs;
  assert.equal(tilesIn(customs, customs.tilePath, 0)[0].path, "customs_0.16/main/0/0/0.png");
  // A map ending exactly on a tile edge does not pull in the next tile.
  const exact = { transform: [1, 0, 1, 0], coordinateRotation: 0, bounds: [[0, 0], [256, -512]], tileSize: 256, layers: [] };
  assert.deepEqual(tilesIn(exact, "t/{z}/{x}/{y}", 0).map((tile) => tile.path), ["t/0/0/0", "t/0/0/1"]);
  assert.equal(tileZoom(customs, 1), 0);
  assert.equal(tileZoom(customs, 8), 3);
  assert.equal(tileZoom(customs, 1000), customs.maxZoom);
  assert.equal(tileZoom(customs, 0.01), 0);
  assert.equal(tileRange(customs, 3, { x: -1000, y: -1000, width: 10, height: 10 }), null, "outside the map");
  const part = tilesIn(customs, customs.tilePath, 4, { x: 100, y: 80, width: 20, height: 10 });
  assert.ok(part.length > 0 && part.length < 10);
  assert.ok(part.every((tile) => tile.rect.width === 16));
  assert.ok(tileCount(customs) > 1000);
  assert.equal(tileCount(maps.terminal), 0, "SVG only");
});

test("floor order runs underground floors, the base, then the floors above", () => {
  for (const [key, map] of Object.entries(maps)) {
    const order = floorOrder(map), floors = floorsOf(map);
    assert.deepEqual([...order.keys()].sort(), floors.map((floor) => floor.id).sort(), key);
    const rank = (floor) => order.get(floor.id);
    for (const floor of floors) {
      if (floor.underground) assert.ok(rank(floor) < rank(floors[0]), key);
      else if (!floor.base) assert.ok(rank(floor) > rank(floors[0]), key);
    }
  }
});
