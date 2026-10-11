// tarkov.dev map data, mirrored locally by the backend (`src-tauri/src/tarkov_data`).
// Reads are per map so the full response is never loaded at once.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { DataStatus } from "../bindings/DataStatus";
import type { MapEntry } from "../bindings/MapEntry";
import type { CommonData, GameMapData } from "./types";
import type { DataMode } from "./mode";

export type * from "./types";
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

/** Index entry for any name the game or tarkov.dev uses: normalized name, game id, scene, or English name. */
export function findMapEntry(status: DataStatus | null, name: string | null | undefined): MapEntry | null {
  if (!status?.manifest || !name) return null;
  const key = name.trim().toLowerCase().replace(/^maps\//, "").replace(/\.bundle$/, "");
  return status.manifest.maps.find((map) =>
    [map.normalized_name, map.name_id, map.scene, map.name].some((alias) => alias.toLowerCase() === key)) ?? null;
}

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

type Named = { name: string; normalizedName: string };
/** Name tables the map documents point into, by id or mob key. */
export type NameLookups = { containers: Record<string, Named>; weapons: Record<string, Named>; mobs: Record<string, Named> };

// Mobs are several MB; keep only the names, once per mode and sync.
const lookupCache = new Map<string, Promise<NameLookups>>();
const names = (table: Record<string, unknown>): Record<string, Named> => Object.fromEntries(
  Object.entries(table).map(([key, value]) => {
    const { name, normalizedName } = value as Named;
    return [key, { name, normalizedName }];
  }));

/** Container, stationary weapon and mob names for a mode, reloaded when the local mirror is refreshed. */
export function useNameLookups(status: DataStatus | null, mode: DataMode = "pve"): NameLookups | null {
  const [lookups, setLookups] = useState<NameLookups | null>(null);
  const fetchedAt = status?.manifest?.fetched_at;
  useEffect(() => {
    setLookups(null);
    if (!fetchedAt) return;
    const key = `${mode}|${fetchedAt}`;
    let pending = lookupCache.get(key);
    if (!pending) {
      pending = Promise.all([getCommonData(mode), getMobs(mode)]).then(([common, mobs]) => ({
        containers: names(common.lootContainers), weapons: names(common.stationaryWeapons), mobs: names(mobs),
      }));
      pending.catch(() => lookupCache.delete(key));
      lookupCache.set(key, pending);
    }
    let live = true;
    pending.then((next) => { if (live) setLookups(next); }, () => {});
    return () => { live = false; };
  }, [fetchedAt, mode]);
  return lookups;
}

/** One map's data for a mode, reloaded when the local mirror is refreshed. */
export function useMapData(normalizedName: string | null | undefined, status: DataStatus | null, mode: DataMode = "pve"): GameMapData | null {
  const [data, setData] = useState<GameMapData | null>(null);
  const fetchedAt = status?.manifest?.fetched_at;
  useEffect(() => {
    setData(null);
    if (!normalizedName || !fetchedAt) return;
    let live = true;
    getMapData(normalizedName, mode).then((next) => { if (live) setData(next); }, () => {});
    return () => { live = false; };
  }, [normalizedName, fetchedAt, mode]);
  return data;
}
