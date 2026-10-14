import { maps } from "./catalog.ts";
import type { MapRoom } from "./rooms.ts";

/**
 * Floor rooms by map art, from src/maps/floor-data/<art>.json (drawn on the dev Floors page). Attaching them to the shared
 * calibration means every game map using that art (Ground Zero and 21+, …) takes its floors from them.
 */
const files = import.meta.glob<{ map: string; rooms: MapRoom[] }>("./floor-data/*.json", { eager: true, import: "default" });
for (const data of Object.values(files)) setRooms(data.map, data.rooms);

/** Replaces an art's rooms; the dev Floors page calls this as it saves, so the map shows edits without a reload. */
export function setRooms(art: string, rooms: MapRoom[]) {
  const map = maps[art];
  if (!map) return;
  // Only what matching needs: the dataset's own fields (ids, copy links) stay out of the calibration.
  map.rooms = rooms.map(({ floor, zone, height, rect, area }) => ({ floor, zone, height, ...rect ? { rect } : {}, ...area ? { area } : {} }));
}
