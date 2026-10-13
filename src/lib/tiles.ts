import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ASSET_HOST, tileRange, tileSets, webAssets, type MapAssets, type MapCalibration } from "../maps";
import type { CacheStats } from "../bindings/CacheStats";
import type { PrefetchStatus } from "../bindings/PrefetchStatus";
import type { TileJob } from "../bindings/TileJob";

export type { CacheStats, PrefetchStatus };

// In the desktop app tiles and images go through the backend disk cache (`tiles` URI scheme); elsewhere straight to the host.
/** Map images through the desktop cache; the host serves item icons from its root, the cache keys them under `items/`. */
function desktopAssets(): MapAssets {
  const base = convertFileSrc("", "tiles");
  return {
    tile: (path) => base + path,
    item: (id) => `${base}items/${id}-512.webp`,
    link: (url) => url.startsWith(ASSET_HOST) ? `${base}items/${url.slice(ASSET_HOST.length)}` : url,
  };
}
/** This app's map assets: cached in the desktop app, from tarkov.dev in a browser. */
export const appAssets: MapAssets = isTauri() ? desktopAssets() : webAssets;

/** Every tile of a map: each tile set at each zoom, limited to the map bounds. */
export function tileJobs(map: MapCalibration): TileJob[] {
  const jobs: TileJob[] = [];
  for (const template of tileSets(map)) {
    for (let z = 0; z <= (map.maxZoom ?? -1); z++) {
      const range = tileRange(map, z);
      if (range) jobs.push({ template, z, x0: range.x0, x1: range.x1, y0: range.y0, y1: range.y1 });
    }
  }
  return jobs;
}

export const getCacheStats = () => invoke<CacheStats>("tile_cache_stats");
export const getCoverage = (map: MapCalibration) => invoke<number>("tile_cache_coverage", { jobs: tileJobs(map) });
export const getPrefetchStatus = () => invoke<PrefetchStatus>("tile_prefetch_status");
export const prefetchTiles = (label: string, jobs: TileJob[]) => invoke<void>("tile_prefetch", { label, jobs });
export const cancelPrefetch = () => invoke<void>("tile_prefetch_cancel");
export const clearTileCache = () => invoke<void>("tile_cache_clear");
export const onPrefetch = (receive: (status: PrefetchStatus) => void) =>
  listen<PrefetchStatus>("tiles:prefetch", (event) => receive(event.payload));
