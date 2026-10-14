import { useCallback, useEffect, useRef, useState } from "react";
import { floorsOf } from "../maps/floors";
import { roomAt, setRooms, type MapCalibration, type MapRoom, type RoomShape, type WorldPoint } from "../maps";

/**
 * Dev: the floor dataset, one per map art, in src/maps/floor-data/<art>.json, edited through the dev server
 * (scripts/floor-data-plugin.mjs). Its rooms are the map library's floor rooms (src/maps/rooms.ts): they decide floors on the
 * map, and saving here hands them to it straight away.
 */
export { heightMiss, inRoom, roomBox, roomCorners, roomRings, tenth, toRoom, type RoomRect, type RoomShape } from "../maps";

/** A screenshot position labelled with the floor it was really taken on. */
export type FloorSample = {
  /** Screenshot filename. */
  id: string;
  x: number; y: number; z: number;
  /** Floor id (`floorsOf`): a tarkov.dev layer name, or `ground`. */
  floor: string;
  /** Building or room, as named by hand. */
  zone?: string;
  /** What the dataset's rooms said when it was labelled. */
  guess: { floor: string; zone?: string };
  /** When it was labelled. */
  at: string;
};

/** A room in the dataset: a map room (where a floor is, and the heights it covers) with what editing needs. */
export type FloorRoom = MapRoom & {
  id: string;
  /** `data`: copied from the app's floor data, heights as they were. */
  heightSource: "manual" | "data";
  /** Key (`DataRoom.key`) of the floor data room this copies; that one is hidden while the copy exists. */
  source?: string;
};

/** A room in the app's floor data: a box (tarkov.dev `bounds`) or a footprint (`areas`) of one floor extent. */
export type DataRoom = RoomShape & { key: string; floor: string; zone: string; height: [number | null, number | null] };

export type FloorDataset = { map: string; samples: FloorSample[]; rooms: FloorRoom[] };

const open = (value: number) => Math.abs(value) >= 1000 ? null : value;
const hash = (text: string) => { let value = 5381; for (let at = 0; at < text.length; at++) value = (value * 33 + text.charCodeAt(at)) | 0; return (value >>> 0).toString(36); };
const rooms = new WeakMap<MapCalibration, DataRoom[]>();

/**
 * The rooms in a map's floor data, keyed by floor and shape so a copy still finds its original after the data is rebuilt.
 * tarkov.dev lists some boxes twice on a floor with different heights; repeats get `|2`, `|3`… in listed order.
 */
export function dataRooms(map: MapCalibration): DataRoom[] {
  let found = rooms.get(map);
  if (found) return found;
  found = [];
  const seen = new Map<string, number>();
  const unique = (key: string) => { const count = (seen.get(key) ?? 0) + 1; seen.set(key, count); return count === 1 ? key : `${key}|${count}`; };
  for (const layer of map.layers) for (const extent of layer.extents ?? []) {
    const height: [number | null, number | null] = [open(extent.height[0]), open(extent.height[1])];
    for (const bounds of extent.bounds ?? []) {
      const [[x1, z1], [x2, z2]] = bounds;
      const rect = { x: (x1 + x2) / 2, z: (z1 + z2) / 2, width: Math.abs(x2 - x1), depth: Math.abs(z2 - z1), angle: 0 };
      const zone = typeof bounds[2] === "string" ? bounds[2] : extent.label ?? "";
      found.push({ key: unique(`${layer.name}|box|${hash(JSON.stringify([x1, z1, x2, z2]))}`), floor: layer.name, zone, height, rect });
    }
    for (const area of extent.areas ?? []) {
      found.push({ key: unique(`${layer.name}|area|${hash(JSON.stringify(area))}`), floor: layer.name, zone: extent.label ?? "", height, area });
    }
  }
  rooms.set(map, found);
  return found;
}

/** A dataset room copied from the floor data, to edit in its place. */
export function copyRoom(room: DataRoom): FloorRoom {
  const shape: RoomShape = room.rect ? { rect: { ...room.rect } } : { area: (room.area ?? []).map((ring) => ring.map(([x, z]): [number, number] => [x, z])) };
  return { id: Math.random().toString(36).slice(2, 10), zone: room.zone, floor: room.floor, height: [...room.height], heightSource: "data", source: room.key, ...shape };
}

/** The floor the dataset's rooms put a point on (see `roomAt`), and the room that decides it; outside every room, the ground. */
export function datasetFloorAt(map: MapCalibration, rooms: FloorRoom[], point: Required<WorldPoint>): { floor: string; room: FloorRoom | null } {
  const room = roomAt(rooms, point);
  return { floor: room?.floor ?? floorsOf(map)[0].id, room };
}

/** The dataset's floor at a point, and the zone of the room that decides it. */
export function guessAt(map: MapCalibration, rooms: FloorRoom[], point: Required<WorldPoint>): { floor: string; zone?: string } {
  const { floor, room } = datasetFloorAt(map, rooms, point);
  return room?.zone ? { floor, zone: room.zone } : { floor };
}

const cache = new Map<string, FloorDataset>();
const empty = (map: string): FloorDataset => ({ map, samples: [], rooms: [] });

/** Writes are whole datasets, one at a time per map, so a slow write never lands after a newer one. */
const queue = new Map<string, Promise<unknown>>();
function write(data: FloorDataset) {
  const next = (queue.get(data.map) ?? Promise.resolve()).then(async () => {
    const response = await fetch(`/__dev/floor-data/${data.map}`, { method: "POST", body: JSON.stringify(data) });
    if (!response.ok) throw new Error(await response.text());
  });
  queue.set(data.map, next.catch(() => {}));
  return next;
}

/**
 * A map's floor dataset, and edits that save it. Keyed by map art (`GameMap.art`), so variants sharing art share one dataset.
 * Null map: nothing loaded.
 */
export function useFloorData(map: string | null) {
  const [data, setData] = useState<FloorDataset | null>(() => map ? cache.get(map) ?? null : null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(data);
  current.current = data;

  useEffect(() => {
    setError(null);
    if (!map) { setData(null); return; }
    setData(cache.get(map) ?? null);
    let disposed = false;
    fetch(`/__dev/floor-data/${map}`).then((response) => response.ok ? response.json() : Promise.reject(new Error(`${response.status}`)))
      .then((loaded: FloorDataset) => { if (disposed) return; cache.set(map, loaded); setData(loaded); setRooms(map, loaded.rooms); },
        (cause) => { if (!disposed) { setError(`Floor data unavailable (dev server only): ${cause}`); setData(cache.get(map) ?? empty(map)); } });
    return () => { disposed = true; };
  }, [map]);

  const update = useCallback((change: (data: FloorDataset) => FloorDataset) => {
    if (!map) return;
    const next = change(current.current ?? cache.get(map) ?? empty(map));
    cache.set(map, next);
    current.current = next;
    setData(next);
    setRooms(map, next.rooms);
    write(next).then(() => setError(null), (cause) => setError(`Not saved: ${cause}`));
  }, [map]);

  return {
    data, error,
    setSample: (sample: FloorSample) => update((data) => ({ ...data, samples: [...data.samples.filter((other) => other.id !== sample.id), sample] })),
    removeSample: (id: string) => update((data) => ({ ...data, samples: data.samples.filter((other) => other.id !== id) })),
    setRoom: (room: FloorRoom) => update((data) => ({ ...data, rooms: data.rooms.some((other) => other.id === room.id)
      ? data.rooms.map((other) => other.id === room.id ? room : other) : [...data.rooms, room] })),
    removeRoom: (id: string) => update((data) => ({ ...data, rooms: data.rooms.filter((other) => other.id !== id) })),
  };
}

export type FloorData = ReturnType<typeof useFloorData>;
