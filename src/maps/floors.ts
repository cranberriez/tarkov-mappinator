import type { FloorExtent, MapCalibration, MapFloor, WorldBounds, WorldPoint } from "./types.ts";

/** Id of a map's ground floor when its base art is not one of the floors tarkov.dev lists. */
export const GROUND = "ground";

/**
 * A floor of a map. A floor goes by one id everywhere: listed floors by their tarkov.dev name, and the map's
 * base art, when no listed floor draws it, by `GROUND`.
 */
export type Floor = {
  id: string;
  /** Display name. */
  name: string;
  /** Drawn by the map's base art; every map has exactly one, listed first. */
  base: boolean;
  underground: boolean;
  /** Id of the top-level `<g>` in the SVG, when the vector art has this floor. */
  svgLayer?: string;
  /** Tile path template, when tiles exist for this floor. */
  tilePath?: string;
  extents?: FloorExtent[];
};

/** The floors shown: one floor's id, or null for every floor. */
export type FloorSelection = string | null;

/** Opacity of underground floors drawn over the ground when every floor is shown. */
export const UNDERGROUND_OPACITY = 0.3;

/** A floor below the ground: tarkov.dev gives these an open-ended lower height bound. */
const underground = (layer: Pick<MapFloor, "extents">) => !!layer.extents?.some((extent) => extent.height[0] <= -1000);

const cache = new WeakMap<MapCalibration, Floor[]>();

/** A map's floors: the base first, then the others in tarkov.dev's order. */
export function floorsOf(map: MapCalibration): Floor[] {
  let floors = cache.get(map);
  if (floors) return floors;
  // A listed floor drawn by the base art (Icebreaker's Infirmary) is the base floor itself.
  const drawsBase = (layer: MapFloor) =>
    (!!layer.tilePath && layer.tilePath === map.tilePath) || (!!layer.svgLayer && layer.svgLayer === map.svgLayer);
  const baseLayer = map.layers.find(drawsBase);
  const listed = map.layers.map((layer): Floor => ({
    id: layer.name, name: layer.name, base: layer === baseLayer, underground: underground(layer),
    svgLayer: layer.svgLayer ?? (layer === baseLayer ? map.svgLayer : undefined),
    tilePath: layer.tilePath ?? (layer === baseLayer ? map.tilePath : undefined), extents: layer.extents,
  }));
  const base: Floor = listed.find((floor) => floor.base)
    ?? { id: GROUND, name: map.svgLayer?.replace(/_/g, " ") ?? "Ground", base: true, underground: false, svgLayer: map.svgLayer, tilePath: map.tilePath };
  floors = [base, ...listed.filter((floor) => floor !== base)];
  cache.set(map, floors);
  return floors;
}

/** The base floor of a map. */
export const baseFloor = (map: MapCalibration): Floor => floorsOf(map)[0];

/** A floor by id, or null when the map has none by that id. */
export const floorById = (map: MapCalibration, id: string | null | undefined): Floor | null =>
  id == null ? null : floorsOf(map).find((floor) => floor.id === id) ?? null;

const within = ([[x1, z1], [x2, z2]]: WorldBounds, { x, z }: WorldPoint) =>
  x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && z >= Math.min(z1, z2) && z <= Math.max(z1, z2);

/**
 * The floor a world position is on; the base floor when no other matches or the height is unknown.
 * Later floors win when several match, as tarkov.dev lists them bottom to top.
 */
export function floorAt(map: MapCalibration, point: WorldPoint): Floor {
  const floors = floorsOf(map);
  if (point.y === undefined) return floors[0];
  const height = point.y;
  let match: MapFloor | null = null;
  for (const layer of map.layers) {
    const hit = layer.extents?.some((extent) =>
      height >= extent.height[0] && height < extent.height[1]
      && (!extent.bounds || extent.bounds.some((bounds) => within(bounds, point))));
    if (hit) match = layer;
  }
  return (match && floorById(map, match.name)) ?? floors[0];
}
