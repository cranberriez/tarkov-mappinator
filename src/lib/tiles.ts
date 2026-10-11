import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TILE_HOST, tileRange, tileSets, type MapCalibration } from "../maps";
import type { CacheStats } from "../bindings/CacheStats";
import type { PrefetchStatus } from "../bindings/PrefetchStatus";
import type { TileJob } from "../bindings/TileJob";

export type { CacheStats, PrefetchStatus };

// In the desktop app tiles go through the backend disk cache (`tiles` URI scheme); elsewhere straight to the host.
const base = isTauri() ? convertFileSrc("", "tiles") : TILE_HOST;
export const tileUrl = (path: string) => base + path;

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
