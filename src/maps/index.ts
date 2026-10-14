// Tarkov map library: game map identities, vendored SVG artwork, tarkov.dev calibration and tile paths,
// world → map projection, floors, overlay markers from tarkov.dev data, player positions, and the `<TarkovMap>`
// component that draws them. Self-contained: imports nothing from the rest of the app. See README.md.
// Refresh the vendored data with `node scripts/vendor-maps.mjs`.
export type * from "./types.ts";
export type * from "./data.ts";
export { ASSET_HOST, DATA_HOST, TILE_HOST } from "./hosts.ts";
export { games, mapName, maps, mapSources, normalizeMapName, resolveGame, resolveMap } from "./catalog.ts";
export { setRooms } from "./roomData.ts";
export { heightMiss, inRoom, roomAt, roomBox, roomCorners, roomRings, tenth, toRoom, type MapRoom, type RoomRect, type RoomShape } from "./rooms.ts";
export { artRect, metricProjection, planeRect, projectionFor, type MapProjection } from "./projection.ts";
export { baseFloor, extentsAt, floorAt, floorById, floorLevels, floorOf, floorsOf, GROUND, levelText, UNDERGROUND_OPACITY, type ExtentHit, type Floor, type FloorSelection } from "./floors.ts";
export { tileBounds, tileCount, tilePathAt, tileRange, tileSets, tileZoom, tilesIn, type Tile } from "./tiles.ts";
export { iconUrl, MapAssetsContext, useMapAssets, webAssets, type MapAssets } from "./assets.ts";
export { containerIcon, mapIcons } from "./icons.ts";
export { documentLocations, documentPhoto, documentSource, type DocumentLocation } from "./documents.ts";
export { tarkovPreset, type CategoryDef, type DocumentType, type DynamicLayer, type GroupDef, type LayerDef, type MarkerPreset } from "./markerPreset.ts";
export {
  buildMarkers, countMarkers, defaultFilters, groupOn, isVisible, layerState, layersFor, markerIcon, markerTint, roleOf, sameFilters,
  toggleLayer, withDefaults, type BossInfo, type Detail, type Filters, type LayerFilter, type Lookups, type MapMarker, type Role,
} from "./markers.ts";
export { freshness, usePlayerTracks, withPosition, type PlayerPosition, type PlayerTrack, type TrackInfo } from "./players.ts";
export { httpMapSource, useLookups, useMapData, type MapDataSource } from "./source.ts";
export { translate } from "./translate.ts";
export { initialView, useMapViewport, type MapViewport, type View } from "./useMapViewport.ts";
export { MapArt, loadMapSvg, type FloorSlot } from "./MapArt.tsx";
export { MapTiles, type TileView } from "./MapTiles.tsx";
export { MapOverlay, type OverlayArea } from "./MapOverlay.tsx";
export { artStyleOf, TarkovMap, type ArtStyle, type MapDrawView, type TarkovMapHandle, type TarkovMapProps } from "./TarkovMap.tsx";
