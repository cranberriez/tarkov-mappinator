// Refreshes the vendored map library in src/maps from pinned upstream commits.
//   node scripts/vendor-maps.mjs [svgCommit] [tarkovDevCommit]
// Writes src/maps/assets/{svg,icons}/* and src/maps/calibration.json (game identities, art calibration, tile paths). Review the diff before committing.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SVG_REPO = "the-hideout/tarkov-dev-svg-maps";
const DEV_REPO = "the-hideout/tarkov-dev";
const svgCommit = process.argv[2] ?? "5a8b6115d1c0cf56f2ebaac1a96fa5ae3074d178";
const devCommit = process.argv[3] ?? "97ff6e7a43d03c10f3f7a3165c8dbcdf2193d6b9";
const API = "https://json.tarkov.dev/pve";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "maps");
const raw = (repo, commit, path) => `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;

async function get(url, as = "text") {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return as === "json" ? response.json() : as === "bytes" ? new Uint8Array(await response.arrayBuffer()) : response.text();
}

async function replaceDir(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

const groups = await get(raw(DEV_REPO, devCommit, "src/data/maps.json"), "json");
const [apiMaps, apiNames] = await Promise.all([get(`${API}/maps`, "json"), get(`${API}/maps_en`, "json")]);
const gameMaps = Object.values(apiMaps.data.maps);

const TILE_HOST = "https://assets.tarkov.dev/maps/";
const tilePath = (url) => {
  if (!url) return undefined;
  if (!url.startsWith(TILE_HOST)) throw new Error(`Unexpected tile host: ${url}`);
  return url.slice(TILE_HOST.length);
};

// Interactive maps with vector art and/or Leaflet tiles.
const interactive = groups.flatMap((group) => group.maps)
  .filter((map) => map.projection === "interactive" && (map.svgPath || map.tilePath));

const calibration = {};
const artFor = new Map();
const svgFiles = new Set();
for (const map of interactive) {
  const svg = map.svgPath?.split("/").pop();
  if (svg) svgFiles.add(svg);
  for (const key of [map.key, ...(map.altMaps ?? [])]) artFor.set(key, map.key);
  calibration[map.key] = {
    key: map.key,
    transform: map.transform,
    coordinateRotation: map.coordinateRotation ?? 0,
    bounds: map.bounds,
    ...(map.svgBounds && { svgBounds: map.svgBounds }),
    ...(map.heightRange && { heightRange: map.heightRange }),
    ...(svg && { svg, svgLayer: map.svgLayer }),
    ...(map.tilePath && { tilePath: tilePath(map.tilePath), tileSize: map.tileSize ?? 256, maxZoom: map.maxZoom }),
    layers: (map.layers ?? []).filter((layer) => layer.svgLayer || layer.tilePath).map((layer) => ({
      name: layer.name,
      ...(layer.svgLayer && { svgLayer: layer.svgLayer }),
      ...(layer.tilePath && { tilePath: tilePath(layer.tilePath) }),
      show: !!layer.show,
      ...(layer.extents && { extents: layer.extents }),
    })),
    labels: map.labels ?? [],
  };
}

// Every game map, keyed by tarkov.dev normalizedName, with both identifiers seen in game logs.
const games = gameMaps.map((game) => ({
  key: game.normalizedName,
  name: apiNames.data[game.name] ?? game.normalizedName,
  nameId: game.nameId,
  scene: game.scenePath.replace(/^maps\//, "").replace(/\.bundle$/, ""),
  art: artFor.get(game.normalizedName) ?? null,
})).sort((a, b) => a.key.localeCompare(b.key));

await replaceDir(join(root, "assets", "svg"));
for (const file of svgFiles) {
  await writeFile(join(root, "assets", "svg", file), await get(raw(SVG_REPO, svgCommit, file)));
}

const iconsDir = "public/maps/interactive";
const listing = await get(`https://api.github.com/repos/${DEV_REPO}/contents/${iconsDir}?ref=${devCommit}`, "json");
await replaceDir(join(root, "assets", "icons"));
for (const entry of listing.filter((entry) => entry.name.endsWith(".png"))) {
  await writeFile(join(root, "assets", "icons", entry.name), await get(raw(DEV_REPO, devCommit, `${iconsDir}/${entry.name}`), "bytes"));
}

await writeFile(join(root, "calibration.json"), JSON.stringify({
  source: { svg: `${SVG_REPO}@${svgCommit}`, calibration: `${DEV_REPO}@${devCommit}`, aliases: `${API}/maps` },
  games,
  maps: calibration,
}, null, 1) + "\n");

console.log(`maps: ${Object.keys(calibration).join(", ")}`);
console.log(`games without art: ${games.filter((game) => !game.art).map((game) => game.key).join(", ") || "none"}`);
console.log(`svg: ${svgFiles.size}, icons: ${(await readdir(join(root, "assets", "icons"))).length}`);
