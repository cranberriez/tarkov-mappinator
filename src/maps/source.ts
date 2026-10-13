import { useEffect, useState } from "react";
import type { CommonData, DataMode, GameMapData, Mob } from "./data.ts";
import { DATA_HOST } from "./hosts.ts";
import type { Lookups } from "./markers.ts";
import { translate } from "./translate.ts";

/**
 * Where map data comes from. Treat a source as a snapshot: when the data behind it changes, make a new source
 * object, and everything reading through it reloads.
 */
export type MapDataSource = {
  /** One map's document by tarkov.dev `normalizedName`. */
  map(normalizedName: string, mode: DataMode): Promise<GameMapData>;
  /** Name tables the map documents point into. */
  lookups(mode: DataMode): Promise<Lookups>;
};

type Named = { name: string; normalizedName: string };
/** Only names, so the lookups stay small. */
export const namesOf = (table: Record<string, unknown> | undefined): Record<string, Named> => Object.fromEntries(
  Object.entries(table ?? {}).map(([key, value]) => {
    const { name, normalizedName } = value as Named;
    return [key, { name, normalizedName }];
  }));

type MapsResponse = {
  translations?: string[];
  data: CommonData & { maps: Record<string, GameMapData & { id: string }>; mobs: Record<string, Mob> };
};

/**
 * Reads tarkov.dev's JSON API directly (CORS-open; about 600 KB gzipped per mode), once per mode per source.
 * Loose loot spawns carry no item categories this way.
 */
export function httpMapSource({ host = DATA_HOST, fetch: get = fetch }: { host?: string; fetch?: typeof fetch } = {}): MapDataSource {
  const sets = new Map<DataMode, Promise<MapsResponse["data"]>>();
  const load = (mode: DataMode) => {
    let set = sets.get(mode);
    if (!set) {
      const json = (path: string) => get(`${host}/${mode}/${path}`).then((response) => {
        if (!response.ok) throw new Error(`${response.url}: ${response.status}`);
        return response.json();
      });
      set = Promise.all([json("maps") as Promise<MapsResponse>, json("maps_en") as Promise<{ data: Record<string, unknown> }>])
        .then(([response, names]) => { translate(response, names.data); return response.data; });
      set.catch(() => sets.delete(mode));
      sets.set(mode, set);
    }
    return set;
  };
  return {
    map: async (normalizedName, mode) => {
      const map = Object.values((await load(mode)).maps).find((other) => other.normalizedName === normalizedName);
      if (!map) throw new Error(`No map "${normalizedName}" in ${mode}`);
      return map;
    },
    lookups: async (mode) => {
      const data = await load(mode);
      return { containers: namesOf(data.lootContainers), weapons: namesOf(data.stationaryWeapons), mobs: data.mobs,
        maps: Object.fromEntries(Object.values(data.maps).map((map) => [map.id, map.name])) };
    },
  };
}

/** One map's data through a source, or null while loading, without a source or map, or on failure. */
export function useMapData(source: MapDataSource | null, normalizedName: string | null | undefined, mode: DataMode): GameMapData | null {
  const [data, setData] = useState<GameMapData | null>(null);
  useEffect(() => {
    setData(null);
    if (!source || !normalizedName) return;
    let live = true;
    source.map(normalizedName, mode).then((next) => { if (live) setData(next); }, (error) => console.error(error));
    return () => { live = false; };
  }, [source, normalizedName, mode]);
  return data;
}

/** A source's name lookups for a mode; empty until loaded. */
export function useLookups(source: MapDataSource | null, mode: DataMode): Lookups {
  const [lookups, setLookups] = useState<Lookups>({});
  useEffect(() => {
    setLookups({});
    if (!source) return;
    let live = true;
    source.lookups(mode).then((next) => { if (live) setLookups(next); }, (error) => console.error(error));
    return () => { live = false; };
  }, [source, mode]);
  return lookups;
}
