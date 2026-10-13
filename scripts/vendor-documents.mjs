// Vendors Battle Pass document location photos from the Tarkov Hideout repo and ties each location to a
// tarkov.dev document spawn, so a document marker can show where the document sits.
//   node scripts/vendor-documents.mjs [path/to/tarkov-hideout-tracker]
// Reads the hideout's tarkovdoc.com snapshot (positions in pixels on tarkovdoc's own map images, plus photos),
// fits each map's pixels to world coordinates against tarkov.dev's document spawns, and keeps confident matches.
// Manual links (src/maps/documents/links.json, written by the dev-only linker on the map) always win and anchor the fit;
// a null link marks a location as not any spawn. src/maps/documents/photo-picks.json picks among a location's photos,
// or takes another location's (`{ "from": "<map>/<id>" }`) where the source swapped them.
// Writes src/maps/documents/locations.json and src/maps/assets/documents/*.webp. Review the diff before committing.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hideout = resolve(process.argv[2] ?? join(root, "..", "tarkov-hideout-tracker"));
const docsDir = join(root, "src", "maps", "documents");
const photoDir = join(root, "src", "maps", "assets", "documents");
const API = "https://json.tarkov.dev/pve";
const PHOTO_WIDTH = 800, PHOTO_QUALITY = 75;

/** tarkovdoc map id → tarkov.dev maps sharing its document spawns; the first is fitted against. */
const MAPS = {
  factory: ["factory", "night-factory"], customs: ["customs"], ground_zero: ["ground-zero", "ground-zero-21"],
  interchange: ["interchange"], streets_of_tarkov: ["streets-of-tarkov"], reserve: ["reserve"], lighthouse: ["lighthouse"],
  shoreline: ["shoreline"], woods: ["woods"], lab: ["the-lab"], labyrinth: ["the-labyrinth"], icebreaker: ["icebreaker"],
};
/** Battle Pass document item ids by type; keep in step with `documents` in src/maps/markerPreset.ts. */
const DOCUMENT_ITEMS = {
  "6a31807f17005505b70d5827": "financial", "6a3181f178450ec91c0ea1aa": "project", "6a31824878450ec91c0ea1ae": "blueprints",
  "6a31828557705071410ca00e": "test", "6a3182b72fd891345e047eef": "user", "6a3182dc6cd8de21cf0a3a7d": "medical",
  "6a31830dde69ceafd805afa0": "technical", "6a317b9692cfdcddcb02a58e": "personnel",
};

const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (fallback !== undefined && error.code === "ENOENT") return fallback; throw error; } };
const source = await readJson(join(hideout, "src", "lib", "data", "battle-pass-map-data.json"));
const imagePaths = await readJson(join(hideout, "src", "lib", "data", "battle-pass-map-images.json"));
const links = await readJson(join(docsDir, "links.json"), {});
const picks = await readJson(join(docsDir, "photo-picks.json"), {});
const response = await fetch(`${API}/maps`);
if (!response.ok) throw new Error(`${response.status} ${API}/maps`);
const apiMaps = Object.values((await response.json()).data.maps);

// Complex arithmetic: a similarity transform is q = a·z + b.
const add = (p, q) => [p[0] + q[0], p[1] + q[1]], sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const mul = (p, q) => [p[0] * q[0] - p[1] * q[1], p[0] * q[1] + p[1] * q[0]];
const div = (p, q) => { const d = q[0] ** 2 + q[1] ** 2; return [(p[0] * q[0] + p[1] * q[1]) / d, (p[1] * q[0] - p[0] * q[1]) / d]; };
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
/** Weighted least-squares similarity taking points `from` onto `to`. */
function similarity(from, to, weights = from.map(() => 1)) {
  let total = 0, cf = [0, 0], ct = [0, 0];
  from.forEach((z, i) => { total += weights[i]; cf = add(cf, [z[0] * weights[i], z[1] * weights[i]]); ct = add(ct, [to[i][0] * weights[i], to[i][1] * weights[i]]); });
  cf = [cf[0] / total, cf[1] / total]; ct = [ct[0] / total, ct[1] / total];
  let num = [0, 0], den = 0;
  from.forEach((z, i) => {
    const dz = sub(z, cf), dq = sub(to[i], ct), w = weights[i];
    num = add(num, [w * (dq[0] * dz[0] + dq[1] * dz[1]), w * (dq[1] * dz[0] - dq[0] * dz[1])]);
    den += w * (dz[0] ** 2 + dz[1] ** 2);
  });
  const a = [num[0] / den, num[1] / den];
  return (z) => add(mul(a, sub(z, cf)), ct);
}

/**
 * Best axis-aligned similarity from image pixels to world (x, z), by sampling pairs of same-type spawns and scoring
 * every location's distance to its nearest unused same-type spawn, truncated at `tol` (MSAC).
 */
function ransac(theirs, ours, tol) {
  const byType = (type) => ours.filter((spawn) => spawn.types.has(type));
  let best = null;
  for (let i = 0; i < theirs.length; i++) for (let j = i + 1; j < theirs.length; j++) {
    for (const oa of byType(theirs[i].type)) for (const ob of byType(theirs[j].type)) {
      if (oa === ob) continue;
      const a = div(sub(ob.p, oa.p), sub(theirs[j].z, theirs[i].z));
      const scale = Math.hypot(...a);
      if (scale < 0.01 || scale > 2) continue;
      const quarter = Math.atan2(a[1], a[0]) * 2 / Math.PI;
      if (Math.abs(quarter - Math.round(quarter)) > 0.06) continue;
      const b = sub(oa.p, mul(a, theirs[i].z));
      const used = new Set();
      let cost = 0;
      for (const location of theirs) {
        const q = add(mul(a, location.z), b);
        let near = Infinity, spawn = null;
        for (const other of byType(location.type)) { if (used.has(other)) continue; const d = dist(other.p, q); if (d < near) { near = d; spawn = other; } }
        if (near < tol) used.add(spawn);
        cost += Math.min(near, tol);
      }
      if (!best || cost < best.cost) best = { cost, fit: (z) => add(mul(a, z), b) };
    }
  }
  return best?.fit;
}

/** Ties one map's locations to spawns: returns, per location id, a spawn (confident) or an estimated world point. */
function matchMap(theirs, ours, linked) {
  const xs = ours.map((spawn) => spawn.p[0]), zs = ours.map((spawn) => spawn.p[1]);
  const extent = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  const tol = Math.max(6, 0.04 * extent);
  const byType = (type) => ours.filter((spawn) => spawn.types.has(type));
  // Manual links pin a location to the spawn under it (or just its point, where tarkov.dev has none).
  const fixed = theirs.filter((location) => linked[location.id]).map((location) => {
    const point = [linked[location.id].x, linked[location.id].z];
    const spawn = ours.find((other) => dist(other.p, point) < 1) ?? null;
    return { location, point, spawn };
  });
  // The whole-map fit comes from the spawns; hand-made links tend to cluster, so they only seed it where there are no spawns.
  const global = ours.length ? ransac(theirs, ours, tol) : fixed.length >= 2 ? similarity(fixed.map((pin) => pin.location.z), fixed.map((pin) => pin.point)) : null;
  if (!global) return new Map();
  let estimate = new Map(theirs.map((location) => [location, global(location.z)]));
  let pairs = [];
  for (let round = 0; round < 8; round++) {
    // One-to-one, same type, nearest first; linked locations and their spawns are spoken for.
    const takenLocations = new Set(fixed.map((pin) => pin.location)), takenSpawns = new Set(fixed.map((pin) => pin.spawn).filter(Boolean));
    const candidates = [];
    for (const location of theirs) if (!takenLocations.has(location)) for (const spawn of byType(location.type)) {
      if (!takenSpawns.has(spawn)) candidates.push({ d: dist(spawn.p, estimate.get(location)), location, spawn });
    }
    candidates.sort((a, b) => a.d - b.d);
    pairs = [];
    for (const candidate of candidates) {
      if (takenLocations.has(candidate.location) || takenSpawns.has(candidate.spawn) || candidate.d > 3 * tol) continue;
      takenLocations.add(candidate.location); takenSpawns.add(candidate.spawn); pairs.push(candidate);
    }
    // Moving least squares: each location's own similarity, weighted towards nearby anchors, leaving itself out.
    const anchors = [...fixed.map((pin) => ({ location: pin.location, p: pin.point })),
      ...pairs.filter((pair) => pair.d < tol).map((pair) => ({ location: pair.location, p: pair.spawn.p }))];
    if (anchors.length < 3) break;
    const sigma = extent / 24;
    estimate = new Map(theirs.map((location) => {
      const others = anchors.filter((anchor) => anchor.location !== location);
      const at = global(location.z);
      const weights = others.map((anchor) => 1 / (dist(global(anchor.location.z), at) ** 2 + sigma ** 2));
      return [location, similarity(others.map((anchor) => anchor.location.z), others.map((anchor) => anchor.p), weights)(location.z)];
    }));
  }
  const result = new Map();
  for (const location of theirs) {
    const pair = pairs.find((candidate) => candidate.location === location);
    const runnerUp = byType(location.type).map((spawn) => dist(spawn.p, estimate.get(location))).sort((a, b) => a - b)[1] ?? Infinity;
    const confident = pair && pair.d < Math.max(5, 0.012 * extent) && runnerUp > 2 * pair.d;
    result.set(location.id, confident ? { spawn: pair.spawn } : { estimate: estimate.get(location) });
  }
  return result;
}

const round = (value) => Math.round(value * 100) / 100;
const point = ({ x, y, z }) => ({ x: round(x), ...y === undefined ? {} : { y: round(y) }, z: round(z) });
const locations = [];
const stats = [];
for (const [mapId, keys] of Object.entries(MAPS)) {
  const raw = source.locations.filter((location) => location.mapId === mapId);
  if (!raw.length) throw new Error(`No tarkovdoc locations for ${mapId}`);
  // Image y points down; flipping it keeps a fit a rotation rather than a reflection.
  const uid = (location) => `${mapId}/${location.id}`;
  // A pick is the index of the photo to use, or `{ from, index? }` to take another location's photo where tarkovdoc mixed them up.
  const photoOf = (location) => {
    const pick = picks[uid(location)] ?? 0;
    if (typeof pick === "number") return { photos: location.screenshotUrls, pick };
    const from = raw.find((other) => uid(other) === pick.from);
    if (!from) throw new Error(`photo-picks.json: ${uid(location)} takes its photo from unknown ${pick.from}`);
    return { photos: from.screenshotUrls, pick: pick.index ?? 0 };
  };
  const theirs = raw.map((location) => ({ id: uid(location), type: location.documentKey, z: [location.x, -location.y] }));
  const data = apiMaps.find((map) => map.normalizedName === keys[0]);
  if (!data) throw new Error(`tarkov.dev has no map ${keys[0]}`);
  const ours = (data.lootLoose ?? []).map((loot) => ({ position: loot.position, p: [loot.position.x, loot.position.z],
    types: new Set(loot.items.map((item) => DOCUMENT_ITEMS[item]).filter(Boolean)) })).filter((spawn) => spawn.types.size);
  const matched = matchMap(theirs, ours, links);
  // A spawn linked by hand belongs to that location only.
  const linkedPoints = Object.values(links).filter(Boolean).map((link) => [link.x, link.z]);
  const rejectedSpawn = (spawn) => linkedPoints.some((linked) => dist(linked, spawn.p) < 1);
  let auto = 0, manual = 0;
  for (const location of raw) {
    const { photos, pick } = photoOf(location);
    const id = uid(location), link = links[id], match = matched.get(id);
    const entry = {
      id, maps: keys, type: location.documentKey, title: location.title,
      ...location.description ? { description: location.description } : {}, ...location.key ? { key: location.key } : {},
      ...photos.length ? { photo: `${mapId}-${location.id}.webp` } : {},
    };
    if (link === null) { /* Rejected by hand: no spawn is this location. */ }
    else if (link) { entry.position = point(link); entry.match = "manual"; manual++; }
    else if (match?.spawn && !rejectedSpawn(match.spawn)) { entry.position = point(match.spawn.position); entry.match = "auto"; auto++; }
    else if (match?.estimate) entry.estimate = point({ x: match.estimate[0], z: match.estimate[1] });
    locations.push(entry);
    if (photos.length) entry.source = imagePaths[photos[Math.min(pick, photos.length - 1)]];
  }
  stats.push(`${mapId.padEnd(18)} ${String(raw.length).padStart(3)} locations, ${String(ours.length).padStart(3)} spawns: ${auto} auto, ${manual} manual, ${raw.length - auto - manual} unlinked`);
}

await rm(photoDir, { recursive: true, force: true });
await mkdir(photoDir, { recursive: true });
let bytes = 0;
for (const entry of locations) {
  const from = entry.source;
  delete entry.source;
  if (!entry.photo) continue;
  if (!from) throw new Error(`No bundled photo for ${entry.id} in the hideout image manifest`);
  const output = await sharp(join(hideout, "public", from)).resize({ width: PHOTO_WIDTH, withoutEnlargement: true }).webp({ quality: PHOTO_QUALITY }).toBuffer();
  bytes += output.length;
  await writeFile(join(photoDir, entry.photo), output);
}

await mkdir(docsDir, { recursive: true });
await writeFile(join(docsDir, "locations.json"), JSON.stringify({
  source: { name: source.source.name, url: source.source.url, season: source.source.season, attribution: source.source.attribution },
  locations,
}, null, "\t") + "\n");
console.log(stats.join("\n"));
console.log(`${(await readdir(photoDir)).length} photos, ${(bytes / 1e6).toFixed(1)} MB`);
