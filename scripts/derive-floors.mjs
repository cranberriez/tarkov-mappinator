// Suggests the floor heights of each building in scripts/data/streets-floors.json (see apply-floors.mjs) from tarkov.dev's
// spawn, loot and lock positions: the heights of everything inside a building, sorted, break into levels where they jump by
// a storey's worth, and a floor starts halfway across each jump. Floors a building has art for but no points on are taken
// to be a storey apart. The table is hand-edited from there; this never changes an entry already in it.
//   node scripts/derive-floors.mjs          reports buildings whose table heights differ from the suggestion, or are missing
//   node scripts/derive-floors.mjs --seed   adds the missing buildings to the table, with their suggestion
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { floorArt, inside, sitesOf, siteAt, anchor, UPPER } from "./floor-art.mjs";
import { readTable, TABLE } from "./apply-floors.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const maps = join(here, "..", "src", "maps");
const API = "https://json.tarkov.dev/pve";
const MAP = "streets-of-tarkov";
const seed = process.argv.includes("--seed");
/** Heights this far apart are on different levels. */
const JUMP = 1.5;
/** A building needs this many points to be measured, and a level this many to count as one. */
const MIN_POINTS = 6, MIN_LEVEL = 2;
/** Storey height assumed past the measured levels, and the range a measured one is trusted in. */
const STOREY = 3.6, STOREY_RANGE = [3, 5];
/** Where a floor starts below its storey's floor level, when extrapolated. */
const BELOW = 0.8;
/** An unmeasured building takes the floors of the nearest measured one within this (m); ground is much the same over a street. */
const REACH = 60;
/** Floor starts where nothing nearby is measured: tarkov.dev's bands, shifted down 4 (see vendor-maps.mjs). */
const FALLBACK = { "2nd Floor": 6, "3rd Floor": 11, "4th Floor": 16, "5th Floor": 21 };

const get = async (url) => { const response = await fetch(url); if (!response.ok) throw new Error(`${response.status} ${url}`); return response.json(); };
const { data } = await get(`${API}/maps`);
const game = Object.values(data.maps).find((map) => map.normalizedName === MAP);
const points = [
  ...game.lootContainers.map((container) => container.position), ...game.lootLoose.map((loose) => loose.position),
  ...game.spawns.map((spawn) => spawn.position), ...game.locks.map((lock) => lock.position),
].map(({ x, y, z }) => ({ y, at: [x, z] }));

const calibration = JSON.parse(readFileSync(join(maps, "calibration.json"), "utf8")).maps[MAP];
const sites = sitesOf(floorArt(calibration, readFileSync(join(maps, "assets", "svg", calibration.svg), "utf8")));
const table = existsSync(TABLE) ? readTable() : {};
const buildings = table[MAP] ??= {};
const round = (value, places = 1) => +value.toFixed(places);
const span = (level) => `${round(level[0])}–${round(level.at(-1))} (${level.length})`;

/** Sorted heights split into levels at each jump; levels too small to count join the nearer neighbour. */
function levelsOf(heights) {
  let levels = [];
  for (const y of heights) { if (levels.length && y - levels.at(-1).at(-1) < JUMP) levels.at(-1).push(y); else levels.push([y]); }
  for (let small; (small = levels.findIndex((level) => level.length < MIN_LEVEL)) >= 0 && levels.length > 1;) {
    const gap = (a, b) => levels[b][0] - levels[a].at(-1);
    const into = small === 0 ? 1 : small === levels.length - 1 ? small - 1 : gap(small - 1, small) < gap(small, small + 1) ? small - 1 : small + 1;
    levels[into] = [...levels[into], ...levels[small]].sort((a, b) => a - b);
    levels = levels.filter((_, at) => at !== small);
  }
  return levels;
}

/** The suggested floors of a site: floor → start height, with a note of the levels measured. Null when it has too few points. */
function suggest(site) {
  const heights = points.filter((point) => inside(site.outline, point.at)).map((point) => point.y).sort((a, b) => a - b);
  if (heights.length < MIN_POINTS) return null;
  const storeys = Math.max(1, ...site.pieces.map((piece) => piece.storey));
  let levels = levelsOf(heights);
  // More levels than the art has floors: the closest ones are one floor.
  while (levels.length > storeys + 1) {
    let closest = 1;
    for (let at = 2; at < levels.length; at++) if (levels[at][0] - levels[at - 1].at(-1) < levels[closest][0] - levels[closest - 1].at(-1)) closest = at;
    levels = [...levels.slice(0, closest - 1), [...levels[closest - 1], ...levels[closest]], ...levels.slice(closest + 1)];
  }
  const starts = levels.slice(1).map((level, at) => (levels[at].at(-1) + level[0]) / 2);
  const floorLevels = levels.map((level) => level[0]);
  const measured = floorLevels.length > 1 ? (floorLevels.at(-1) - floorLevels[0]) / (floorLevels.length - 1) : STOREY;
  const storey = Math.min(STOREY_RANGE[1], Math.max(STOREY_RANGE[0], measured));
  while (starts.length < storeys) starts.push(floorLevels[0] + (starts.length + 1) * storey - BELOW);
  const floors = Object.fromEntries(starts.slice(0, storeys).map((start, at) => [UPPER[at][1], round(start, 2)]));
  return { floors, note: `seed: ${heights.length} points, levels ${levels.map(span).join(", ")}${levels.length === 1 ? "; one level measured, check" : ""}` };
}

const named = sites.map((site) => ({ site, suggestion: site.pieces.length ? suggest(site) : null, at: anchor(site.outline) }));
const nearest = (at, candidates) => {
  let best = null, distance = REACH;
  for (const other of candidates) { const gap = Math.hypot(other.at[0] - at[0], other.at[1] - at[1]); if (gap < distance) { distance = gap; best = other; } }
  return best;
};
const measured = named.filter((entry) => entry.suggestion);
const labels = calibration.labels.filter((label) => label.text);
const nameFor = (at) => {
  const label = labels.reduce((best, label) => Math.hypot(label.position[0] - at[0], label.position[1] - at[1]) < Math.hypot(best.position[0] - at[0], best.position[1] - at[1]) ? label : best);
  for (let count = 1; ; count++) { const name = `${label.text.replace(/\.$/, "")} #${count}`; if (!(name in buildings)) return name; }
};

const claimed = new Map(Object.entries(buildings).map(([name, building]) => [siteAt(sites, building.at), name]));
// Names for the buildings to add, given up front so a borrowed suggestion can name where it came from.
const fresh = new Map();
if (seed) for (const entry of named) if (!claimed.has(entry.site)) { const name = nameFor(entry.at); fresh.set(entry.site, name); buildings[name] = null; }
const nameOf = (site) => claimed.get(site) ?? fresh.get(site) ?? site.id;
let added = 0, differ = 0;
for (const entry of named) {
  const { site } = entry;
  let suggestion = entry.suggestion;
  if (!site.pieces.length) {
    // A building with no upper-floor art whose points all sit high has its whole inside above the ground (the TerraGroup
    // office's "2F"): the fallback floor that height is on, over its outline.
    const heights = points.filter((point) => inside(site.outline, point.at)).map((point) => point.y).sort((a, b) => a - b);
    const low = heights[Math.floor(heights.length * 0.2)];
    const layer = heights.length >= MIN_POINTS && Object.entries(FALLBACK).filter(([, start]) => low >= start).at(-1)?.[0];
    if (!layer) continue;
    suggestion = { floors: { [layer]: FALLBACK[layer] }, art: { [layer]: "outline" }, note: `seed: no upper art, ${heights.length} points from ${round(low)}; raised building, check` };
  }
  if (!suggestion) {
    const from = nearest(entry.at, measured), storeys = Math.max(...site.pieces.map((piece) => piece.storey));
    const borrowed = from ? Object.values(from.suggestion.floors) : Object.values(FALLBACK);
    const floors = Object.fromEntries(UPPER.slice(0, storeys).map(([, layer], at) => [layer, round(borrowed[at] ?? borrowed.at(-1) + (at + 1 - borrowed.length) * STOREY, 2)]));
    suggestion = { floors, note: from ? `seed: unmeasured, borrowed from ${nameOf(from.site)}, check` : "seed: unmeasured, tarkov.dev bands, check" };
  }
  const name = claimed.get(site);
  if (name) {
    const current = buildings[name].floors, keys = new Set([...Object.keys(current), ...Object.keys(suggestion.floors)]);
    const off = [...keys].filter((layer) => current[layer] === undefined || suggestion.floors[layer] === undefined || Math.abs(current[layer] - suggestion.floors[layer]) > 0.5);
    if (off.length) { differ++; console.log(`${name}: ${off.map((layer) => `${layer} ${current[layer] ?? "-"} (suggest ${suggestion.floors[layer] ?? "-"})`).join(", ")}  [${suggestion.note}]`); }
  } else if (seed) {
    buildings[fresh.get(site)] = { at: entry.at.map((value) => round(value)), ...suggestion };
    added++;
  } else console.log(`missing: ${site.id} at [${entry.at.map((value) => round(value))}] ${JSON.stringify(suggestion.floors)}  [${suggestion.note}]`);
}

// Names held for buildings that turned out to have nothing to add.
for (const [name, building] of Object.entries(buildings)) if (building === null) delete buildings[name];
if (seed) {
  const lines = Object.entries(table).map(([mapKey, entries]) => ` ${JSON.stringify(mapKey)}: {\n${Object.entries(entries).map(([name, building]) =>
    `  ${JSON.stringify(name)}: ${JSON.stringify(building).replace(/([,:])(?=["\[{\d-])/g, "$1 ")}`).join(",\n")}\n }`);
  writeFileSync(TABLE, `{\n${lines.join(",\n")}\n}\n`);
}
console.log(`${Object.keys(buildings).length} buildings in the table${seed ? `, ${added} added` : ""}, ${differ} differing from the suggestion`);
