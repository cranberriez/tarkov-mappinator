/** World bounds corner pair as [x, z] (tarkov.dev convention). Optional third entry is a debug label. */
export type WorldBounds = [[number, number], [number, number], ...unknown[]];

export type FloorExtent = { height: [number, number]; bounds?: WorldBounds[] };

export type MapFloor = {
  name: string;
  /** Id of the top-level `<g>` in the SVG. */
  svgLayer: string;
  show: boolean;
  extents?: FloorExtent[];
};

export type MapLabel = { position: [number, number]; text: string; rotation?: number; size?: number; top?: number; bottom?: number };

/** Per-map calibration, from tarkov.dev's interactive map definitions. */
export type MapCalibration = {
  key: string;
  svg: string;
  /** Leaflet transformation [scaleX, offsetX, scaleY, offsetY] applied after rotation. */
  transform: [number, number, number, number];
  /** Degrees; world (x, z) is rotated by this before scaling. */
  coordinateRotation: number;
  bounds: WorldBounds;
  /** Where the SVG artwork sits, when it differs from `bounds`. */
  svgBounds?: WorldBounds;
  /** Base floor group id. */
  svgLayer: string;
  heightRange?: [number, number];
  layers: MapFloor[];
  labels: MapLabel[];
  /** Lower-case names that resolve to this map: tarkov.dev keys, game ids, scene names, English names. */
  aliases: string[];
};

export type WorldPoint = { x: number; y?: number; z: number };
export type PlanePoint = { x: number; y: number };
export type PlaneRect = { x: number; y: number; width: number; height: number };
