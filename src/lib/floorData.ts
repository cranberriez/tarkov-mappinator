import { useCallback, useEffect, useRef, useState } from "react";
import { floorsOf } from "../maps/floors";
import type { MapCalibration, WorldArea, WorldPoint } from "../maps";

/**
 * Dev: the floor dataset, one per map, kept in scripts/data/floor-samples/<map>.json through the dev server
 * (scripts/floor-data-plugin.mjs). Separate from the floor data the app uses until exported.
 */

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

/** A box across the ground: centre, size along world X (`width`) and Z (`depth`), turned `angle` degrees about Y. */
export type RoomRect = { x: number; z: number; width: number; depth: number; angle: number };

/** Where a room is across the ground: a box, or rings of [x, z] points (inside: an odd number of rings hold it). */
export type RoomShape = { rect?: RoomRect; area?: WorldArea };

/** A room in the dataset: where a floor is, and the heights (Y) it covers, open-ended where null. */
export type FloorRoom = RoomShape & {
  id: string;
  zone: string;
  floor: string;
  height: [number | null, number | null];
  /** `data`: copied from the app's floor data, heights as they were. */
  heightSource: "manual" | "data";
  /** Key (`DataRoom.key`) of the floor data room this copies; that one is hidden while the copy exists. */
  source?: string;
};

/** A room in the app's floor data: a box (tarkov.dev `bounds`) or a footprint (`areas`) of one floor extent. */
export type DataRoom = RoomShape & { key: string; floor: string; zone: string; height: [number | null, number | null] };

export type FloorDataset = { map: string; samples: FloorSample[]; rooms: FloorRoom[] };

const radians = (degrees: number) => degrees * Math.PI / 180;

/** World [x, z] of a room's corners, in order around it. */
export function roomCorners({ x, z, width, depth, angle }: RoomRect): [number, number][] {
  const cos = Math.cos(radians(angle)), sin = Math.sin(radians(angle));
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]): [number, number] => {
    const lx = u * width / 2, lz = v * depth / 2;
    return [x + lx * cos - lz * sin, z + lx * sin + lz * cos];
  });
}

/** A world point in a room's own axes, from its centre. */
export function toRoom({ x, z, angle }: RoomRect, point: { x: number; z: number }) {
  const cos = Math.cos(radians(angle)), sin = Math.sin(radians(angle)), dx = point.x - x, dz = point.z - z;
  return { u: dx * cos + dz * sin, v: -dx * sin + dz * cos };
}

/** A room's outline as rings of world [x, z] points. */
export const roomRings = (room: RoomShape): [number, number][][] => room.rect ? [roomCorners(room.rect)] : room.area ?? [];

export function inRoom(room: RoomShape, point: { x: number; z: number }) {
  if (room.rect) {
    const { u, v } = toRoom(room.rect, point);
    return Math.abs(u) <= room.rect.width / 2 && Math.abs(v) <= room.rect.depth / 2;
  }
  let inside = false;
  for (const ring of room.area ?? []) for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [x1, z1] = ring[a], [x2, z2] = ring[b];
    if ((z1 > point.z) !== (z2 > point.z) && point.x < (x2 - x1) * (point.z - z1) / (z2 - z1) + x1) inside = !inside;
  }
  return inside;
}

/** The axis-aligned box around a room. */
export function roomBox(room: RoomShape): RoomRect {
  if (room.rect && !room.rect.angle) return room.rect;
  const points = roomRings(room).flat(), xs = points.map((point) => point[0]), zs = points.map((point) => point[1]);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...zs), bottom = Math.max(...zs);
  return { x: (left + right) / 2, z: (top + bottom) / 2, width: right - left, depth: bottom - top, angle: 0 };
}

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

/** Heights (Y) are compared to the nearest tenth: no level needs finer than that. */
export const tenth = (y: number) => Math.round(y * 10) / 10;
const low = (room: FloorRoom) => room.height[0] === null ? -Infinity : tenth(room.height[0]);
const high = (room: FloorRoom) => room.height[1] === null ? Infinity : tenth(room.height[1]);
/** How far a height is outside a room's range, both ends included (0 inside it). */
export const heightMiss = (room: FloorRoom, y: number) => {
  const at = tenth(y);
  return at < low(room) ? tenth(low(room) - at) : at > high(room) ? tenth(at - high(room)) : 0;
};

/**
 * The floor the dataset puts a point on, using its rooms only (not the app's floor data): of the rooms whose outline and
 * height range (both ends included, to the tenth) hold it, the highest-starting one's. Anywhere else, the ground (base
 * floor). Where one floor's range ends at the next one's start, a point at exactly that height goes to the upper floor.
 */
export function datasetFloorAt(map: MapCalibration, rooms: FloorRoom[], point: Required<WorldPoint>): { floor: string; room: FloorRoom | null } {
  const holding = rooms.filter((room) => !heightMiss(room, point.y) && inRoom(room, point));
  if (!holding.length) return { floor: floorsOf(map)[0].id, room: null };
  const room = holding.reduce((best, other) => low(other) > low(best) ? other : best);
  return { floor: room.floor, room };
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

/** A map's floor dataset (by game key), and edits that save it. Null map: nothing loaded. */
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
      .then((loaded: FloorDataset) => { if (disposed) return; cache.set(map, loaded); setData(loaded); },
        (cause) => { if (!disposed) { setError(`Floor data unavailable (dev server only): ${cause}`); setData(cache.get(map) ?? empty(map)); } });
    return () => { disposed = true; };
  }, [map]);

  const update = useCallback((change: (data: FloorDataset) => FloorDataset) => {
    if (!map) return;
    const next = change(current.current ?? cache.get(map) ?? empty(map));
    cache.set(map, next);
    current.current = next;
    setData(next);
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
