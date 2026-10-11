// tarkov.dev map data, mirrored locally by the backend (`src-tauri/src/tarkov_data`).
// Reads are per map so the full response is never loaded at once.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { DataStatus } from "../bindings/DataStatus";
import type { MapEntry } from "../bindings/MapEntry";
import type { CommonData, GameMapData } from "./types";

export type * from "./types";
export type { DataStatus, MapEntry };

export const getDataStatus = () => invoke<DataStatus>("tarkov_data_status");
/** Starts a sync now; progress arrives through `onDataStatus`. */
export const syncData = () => invoke<void>("tarkov_data_sync");
export const getMapData = (normalizedName: string) => invoke<GameMapData>("tarkov_data_map", { name: normalizedName });
export const getCommonData = () => invoke<CommonData>("tarkov_data_common");
/** Boss and follower definitions (several MB). */
export const getMobs = () => invoke<Record<string, unknown>>("tarkov_data_mobs");
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

/** One map's data, reloaded when the local mirror is refreshed. */
export function useMapData(normalizedName: string | null | undefined, status: DataStatus | null): GameMapData | null {
  const [data, setData] = useState<GameMapData | null>(null);
  const fetchedAt = status?.manifest?.fetched_at;
  useEffect(() => {
    setData(null);
    if (!normalizedName || !fetchedAt) return;
    let live = true;
    getMapData(normalizedName).then((next) => { if (live) setData(next); }, () => {});
    return () => { live = false; };
  }, [normalizedName, fetchedAt]);
  return data;
}
