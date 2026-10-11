// Tarkov map library: vendored SVG artwork, tarkov.dev calibration, and world → map projection.
// Self-contained: imports nothing from the rest of the app. Refresh with `node scripts/vendor-maps.mjs`.
export type * from "./types.ts";
export { maps, mapSources, resolveMap } from "./catalog.ts";
export { artRect, floorAt, metricProjection, planeRect, projectionFor, type MapProjection } from "./projection.ts";
export { MapArt, loadMapSvg } from "./MapArt.tsx";
export { containerIcon, mapIcons } from "./icons.ts";
