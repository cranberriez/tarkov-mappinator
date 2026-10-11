// Tarkov map library: game map identities, vendored SVG artwork, tarkov.dev calibration and tile paths,
// and world → map projection. Self-contained: imports nothing from the rest of the app.
// Refresh with `node scripts/vendor-maps.mjs`.
export type * from "./types.ts";
export { games, mapName, maps, mapSources, resolveGame, resolveMap } from "./catalog.ts";
export { artRect, floorAt, metricProjection, planeRect, projectionFor, type MapProjection } from "./projection.ts";
export { TILE_HOST, tileBounds, tileCount, tilePathAt, tileRange, tileSets, tileZoom, tilesIn, type Tile } from "./tiles.ts";
export { MapArt, loadMapSvg } from "./MapArt.tsx";
export { MapTiles, type TileView } from "./MapTiles.tsx";
export { containerIcon, mapIcons } from "./icons.ts";
