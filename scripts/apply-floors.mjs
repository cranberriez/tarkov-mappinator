// Sets the upper floors of the maps in scripts/data/streets-floors.json from that hand-edited table, which is the source of
// truth for which floor a point inside a building is on. tarkov.dev's floors are height bands over the whole map (or boxes),
// which misread buildings on uneven ground; here each building has its own heights, over the footprints drawn for each floor.
//
// Table: map key → building name → entry, where
//   at      [x, z] world point inside the building: its `Floor-1` outline in the SVG (or, outside every outline, the
//           lowest upper-floor footprint there)
//   floors  floor (layer name) → the height (Y) it starts at; it ends where the next higher one starts, the top one never.
//           Below the lowest is the ground.
//   art     optional, floor → where it is: an SVG group (`Floor-3`: its footprints in this building), `outline` (the whole
//           building), a ring of [x, z] points, or a list of these. By default a floor's own group (`2nd Floor`: `Floor-2`),
//           or the outline where the building has none of that art.
//   note    optional, ignored: where the numbers came from.
// Seed missing buildings with `node scripts/derive-floors.mjs --seed`; it also reports where the data disagrees.
//
//   node scripts/apply-floors.mjs     rewrites the floors in src/maps/calibration.json (vendor-maps.mjs also applies it)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { floorArt, sitesOf, siteAt, UPPER } from "./floor-art.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const maps = join(here, "..", "src", "maps");
export const TABLE = join(here, "data", "streets-floors.json");
export const readTable = () => JSON.parse(readFileSync(TABLE, "utf8"));

const OPEN = 10000;
const round = (value) => +value.toFixed(2);
const groupOf = (layer) => UPPER.find(([, name]) => name === layer)?.[0];
const isRing = (value) => Array.isArray(value) && Array.isArray(value[0]) && typeof value[0][0] === "number";
const compact = (area) => area.map((ring) => ring.map(([x, z]) => [round(x), round(z)]).filter((point, at, all) => !at || point[0] !== all[at - 1][0] || point[1] !== all[at - 1][1]));

/** Each building's floors as extents: { layer → [{ height, label, areas }] }, checked against the art. */
export function buildingFloors(calibration, svg, buildings) {
  const sites = sitesOf(floorArt(calibration, svg));
  const claimed = new Map(), byLayer = new Map(), outlined = [];
  for (const [name, building] of Object.entries(buildings)) {
    const site = siteAt(sites, building.at);
    if (!site) throw new Error(`${name}: [${building.at}] is in no building outline or floor footprint`);
    if (claimed.has(site)) throw new Error(`${name} and ${claimed.get(site)} are the same building (${site.id})`);
    claimed.set(site, name);
    const floors = Object.entries(building.floors).sort((a, b) => a[1] - b[1]);
    floors.forEach(([layer, from], index) => {
      let art = building.art?.[layer];
      if (art === undefined) {
        art = groupOf(layer);
        if (!site.pieces.some((piece) => piece.group === art)) { art = "outline"; outlined.push(`${name} ${layer}`); }
      }
      const sources = [art].flatMap((source) => isRing(source) || !Array.isArray(source) ? [source] : source);
      const areas = sources.flatMap((source) => {
        if (source === undefined) throw new Error(`${name}: no art group for ${layer}; give it an \`art\` entry`);
        if (isRing(source)) return [[source]];
        if (source === "outline") return [site.outline];
        const found = site.pieces.filter((piece) => piece.group === source).map((piece) => piece.area);
        if (!found.length) throw new Error(`${name}: no ${source} art in this building for ${layer}; give it an \`art\` entry`);
        return found;
      });
      const extents = byLayer.get(layer) ?? [];
      extents.push({ height: [from, floors[index + 1]?.[1] ?? OPEN], label: name, areas: areas.map(compact) });
      byLayer.set(layer, extents);
    });
  }
  return { sites, claimed, byLayer, outlined };
}

/** The calibration file's text: indented, but each floor area on one line, as they run to thousands of points. */
export function stringifyCalibration(data) {
  const areas = [];
  const text = JSON.stringify(data, (key, value) => key === "areas" ? `@areas:${areas.push(value) - 1}` : value, 1);
  return text.replace(/^( *)"areas": "@areas:(\d+)"/gm, (_, indent, at) =>
    `${indent}"areas": [\n${areas[at].map((area) => `${indent} ${JSON.stringify(area)}`).join(",\n")}\n${indent}]`) + "\n";
}

/** Replaces the upper floors' extents of every map in the table with its buildings' floors. */
export function applyFloors(calibration, svgFor, table = readTable()) {
  for (const [mapKey, buildings] of Object.entries(table)) {
    const map = calibration[mapKey];
    if (!map) throw new Error(`No map ${mapKey}`);
    const { sites, claimed, byLayer, outlined } = buildingFloors(map, svgFor(map.svg), buildings);
    if (outlined.length) console.log(`${mapKey}: floors with no art of their own, over the building outline: ${outlined.join(", ")}`);
    const missing = sites.filter((site) => site.pieces.length && !claimed.has(site));
    if (missing.length) throw new Error(`${mapKey}: buildings with upper floors not in the table: ${missing.map((site) => site.id).join(", ")}; run node scripts/derive-floors.mjs --seed`);
    for (const layer of byLayer.keys()) if (!map.layers.some((other) => other.name === layer)) throw new Error(`No layer ${layer} on ${mapKey}`);
    for (const layer of map.layers) if (groupOf(layer.name)) layer.extents = byLayer.get(layer.name) ?? [];
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const file = join(maps, "calibration.json"), data = JSON.parse(readFileSync(file, "utf8"));
  applyFloors(data.maps, (svg) => readFileSync(join(maps, "assets", "svg", svg), "utf8"));
  writeFileSync(file, stringifyCalibration(data));
  for (const mapKey of Object.keys(readTable())) console.log(`${mapKey}: ${data.maps[mapKey].layers.map((layer) => `${layer.name} ${layer.extents?.length ?? 0}`).join(", ")}`);
}
