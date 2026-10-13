// tarkov.dev map data, mirrored locally by the backend (`src-tauri/src/tarkov_data`).
// Reads are per map so the full response is never loaded at once.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import type { DataStatus } from "../bindings/DataStatus";
import type { MapEntry } from "../bindings/MapEntry";
import type { CommonData, GameMapData, Mob } from "../maps/data";
import type { Lookups } from "../maps/markers";
import { namesOf, type MapDataSource } from "../maps/source";
import { useItemStatus } from "../lib/itemData";
import type { DataMode } from "./mode";

export type * from "../maps/data";
export type { DataStatus, MapEntry };
export { dataMode, type DataMode } from "./mode";

export const getDataStatus = () => invoke<DataStatus>("tarkov_data_status");
/** Starts a sync now; progress arrives through `onDataStatus`. */
export const syncData = () => invoke<void>("tarkov_data_sync");
export const getMapData = (normalizedName: string, mode: DataMode = "pve") =>
  invoke<GameMapData>("tarkov_data_map", { name: normalizedName, mode });
export const getCommonData = (mode: DataMode = "pve") => invoke<CommonData>("tarkov_data_common", { mode });
/** Boss and follower definitions (several MB). */
export const getMobs = (mode: DataMode = "pve") => invoke<Record<string, unknown>>("tarkov_data_mobs", { mode });
export const onDataStatus = (receive: (status: DataStatus) => void) =>
  listen<DataStatus>("tarkov-data:updated", (event) => receive(event.payload));

/** Live sync status; null outside the desktop app or before the first reply. */
export function useDataStatus(): DataStatus | null {
  const [status, setStatus] = useState<DataStatus | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const stop = onDataStatus((next) => { if (live) setStatus(next); });
    getDataStatus().then((next) => { if (live) setStatus(next); }, () => {});
    return () => { live = false; void stop.then((unlisten) => unlisten()); };
  }, []);
  return status;
}

/**
 * The local mirror as a map data source, or null outside the desktop app or before the mirror has data.
 * A new source arrives when the mirror is refreshed, or when item data changes: the backend adds loose loot
 * categories from it to each map document it reads.
 */
export function useDesktopMapSource(): MapDataSource | null {
  const status = useDataStatus();
  const items = useItemStatus();
  const manifest = status?.manifest;
  const itemsVersion = `${items?.config.enabled}|${items?.config.pieces.extra}|${items?.fetched_at}`;
  return useMemo(() => {
    if (!manifest) return null;
    const maps = Object.fromEntries(manifest.maps.map((entry) => [entry.id, entry.name]));
    const lookups = new Map<DataMode, Promise<Lookups>>();
    return {
      map: getMapData,
      lookups: (mode) => {
        let pending = lookups.get(mode);
        if (!pending) {
          // Mobs are several MB; keep only names for containers and guns.
          pending = Promise.all([getCommonData(mode), getMobs(mode)]).then(([common, mobs]) => ({
            containers: namesOf(common.lootContainers), weapons: namesOf(common.stationaryWeapons), mobs: mobs as Record<string, Mob>, maps,
          }));
          pending.catch(() => lookups.delete(mode));
          lookups.set(mode, pending);
        }
        return pending;
      },
    };
  }, [manifest?.fetched_at, itemsVersion]);
}
