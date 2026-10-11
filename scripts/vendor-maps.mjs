// Refreshes the vendored map library in src/maps from pinned upstream commits.
//   node scripts/vendor-maps.mjs [svgCommit] [tarkovDevCommit]
// Writes src/maps/assets/{svg,icons}/* and src/maps/calibration.json. Review the diff before committing.
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

// Only SVG-backed interactive maps; tile-only maps (Labs, Labyrinth, Icebreaker) have no vector art here.
const interactive = groups.flatMap((group) => group.maps).filter((map) => map.projection === "interactive" && map.svgPath);

const calibration = {};
const svgFiles = new Set();
for (const map of interactive) {
  const svg = map.svgPath.split("/").pop();
  svgFiles.add(svg);
  const keys = [map.key, ...(map.altMaps ?? [])];
  const aliases = new Set(keys);
  for (const game of gameMaps.filter((game) => keys.includes(game.normalizedName))) {
    aliases.add(game.nameId);
    aliases.add(game.scenePath.replace(/^maps\//, "").replace(/\.bundle$/, ""));
    const name = apiNames.data[game.name];
    if (name) aliases.add(name);
  }
  calibration[map.key] = {
    key: map.key,
    svg,
    transform: map.transform,
    coordinateRotation: map.coordinateRotation ?? 0,
    bounds: map.bounds,
    ...(map.svgBounds && { svgBounds: map.svgBounds }),
    svgLayer: map.svgLayer,
    ...(map.heightRange && { heightRange: map.heightRange }),
    layers: (map.layers ?? []).filter((layer) => layer.svgLayer).map(({ name, svgLayer, show, extents }) => ({ name, svgLayer, show: !!show, extents })),
    labels: map.labels ?? [],
    aliases: [...new Set([...aliases].map((alias) => alias.toLowerCase()))].sort(),
  };
}

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
  maps: calibration,
}, null, 1) + "\n");

console.log(`maps: ${Object.keys(calibration).join(", ")}`);
console.log(`svg: ${svgFiles.size}, icons: ${(await readdir(join(root, "assets", "icons"))).length}`);
