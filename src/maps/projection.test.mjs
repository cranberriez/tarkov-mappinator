import assert from "node:assert/strict";
import { test } from "node:test";
import { artRect, floorAt, metricProjection, projectionFor } from "./projection.ts";
import { maps, resolveMap } from "./catalog.ts";

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
  assert.equal(floorAt(customs, { ...dorms, y: 1 }), null);
  assert.equal(floorAt(customs, { ...dorms, y: 4 }), "Second_Floor");
  assert.equal(floorAt(customs, { x: -340, z: 200, y: 4 }), null, "outside every 2nd-floor area");
  assert.equal(floorAt(customs, dorms), null, "no height, base floor");
});

test("map names resolve from keys, game ids, scenes and display names", () => {
  for (const name of ["customs", "bigmap", "customs_preset", "maps/customs_preset.bundle", "Customs"]) {
    assert.equal(resolveMap(name)?.key, "customs", name);
  }
  assert.equal(resolveMap("Interchange")?.key, "interchange");
  assert.equal(resolveMap("shopping_mall")?.key, "interchange");
  assert.equal(resolveMap("factory4_night")?.key, "factory");
  assert.equal(resolveMap("laboratory"), null, "no SVG calibration");
  assert.equal(resolveMap(null), null);
});
