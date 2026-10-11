import type { CSSProperties } from "react";
import { TILE_HOST, tileZoom, tilesIn } from "./tiles.ts";
import { isUnderground, UNDERGROUND_OPACITY } from "./projection.ts";
import type { MapCalibration, MapFloor } from "./types.ts";

export type TileView = { cx: number; cy: number; scale: number; width: number; height: number };

const defaultUrl = (path: string) => TILE_HOST + path;

/**
 * Leaflet-style raster tiles for a map with a `tilePath`, drawn for the visible part of `view`
 * (plane centre, pixels per plane unit, frame size). A coarser zoom sits underneath to cover
 * tiles still loading. A floor with its own tiles is drawn over a dimmed base. With `all`, every floor with
 * its own tiles is drawn over the base: underground faintly first, then the upper floors in order.
 */
export function MapTiles({ map, floor = null, all = false, view, tileUrl = defaultUrl, className }: {
  map: MapCalibration & { tilePath: string }; floor?: MapFloor | null; all?: boolean; view: TileView;
  tileUrl?: (path: string) => string; className?: string;
}) {
  const visible = {
    x: view.cx - view.width / 2 / view.scale, y: view.cy - view.height / 2 / view.scale,
    width: view.width / view.scale, height: view.height / view.scale,
  };
  const z = tileZoom(map, view.scale);
  const overlay = floor?.tilePath && floor.tilePath !== map.tilePath ? floor.tilePath : null;
  const floors = all ? map.layers.filter((other) => other.tilePath && other.tilePath !== map.tilePath) : [];
  const layer = (template: string, zoom: number, style?: CSSProperties) =>
    tilesIn(map, template, zoom, visible).map((tile) => {
      const left = Math.floor((tile.rect.x - visible.x) * view.scale);
      const top = Math.floor((tile.rect.y - visible.y) * view.scale);
      // Round edges outward so neighbouring tiles never leave a hairline gap.
      const right = Math.ceil((tile.rect.x + tile.rect.width - visible.x) * view.scale);
      const bottom = Math.ceil((tile.rect.y + tile.rect.height - visible.y) * view.scale);
      return <img key={tile.path} src={tileUrl(tile.path)} alt="" draggable={false} decoding="async"
        onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
        style={{ position: "absolute", left, top, width: right - left, height: bottom - top, ...style }} />;
    });

  return <div className={className} style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
    <div style={{ opacity: overlay && !all ? 0.2 : 1 }}>
      {z > 2 && layer(map.tilePath, z - 2)}
      {layer(map.tilePath, z)}
    </div>
    {all
      ? [...floors.filter(isUnderground), ...floors.filter((other) => !isUnderground(other))].map((other) =>
        <div key={other.name} style={isUnderground(other) ? { opacity: UNDERGROUND_OPACITY } : undefined}>{layer(other.tilePath!, z)}</div>)
      : overlay && layer(overlay, z)}
  </div>;
}
