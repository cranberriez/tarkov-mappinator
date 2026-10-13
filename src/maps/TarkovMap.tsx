import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { floorAt, floorById, type FloorSelection } from "./floors.ts";
import { MapArt } from "./MapArt.tsx";
import { MapOverlay, type OverlayArea } from "./MapOverlay.tsx";
import { MapTiles } from "./MapTiles.tsx";
import type { MarkerPreset } from "./markerPreset.ts";
import type { Filters, MapMarker } from "./markers.ts";
import { freshness, type PlayerPosition, type PlayerTrack } from "./players.ts";
import { artRect, metricProjection, projectionFor } from "./projection.ts";
import { tileBounds } from "./tiles.ts";
import type { MapCalibration, PlaneRect, WorldPoint } from "./types.ts";
import { initialView, useMapViewport } from "./useMapViewport.ts";
import { useSplitLayout, type ArtStyle } from "./useSplitLayout.ts";

export type { ArtStyle };

/** Extract names are drawn from this zoom in (screen px per metre); below it they are hover-only. */
const LABEL_PX_PER_M = 1.2;
/** Split-floor column names show once a column is at least this wide on screen. */
const SPLIT_LABEL_MIN_PX = 36;
/** Overlay markers are culled and thinned for zoom steps of this many per doubling, so zooming only redraws them on a step. */
const OVERLAY_ZOOM_STEPS = 4;

/**
 * The art a map is drawn with: the preferred style when it has it, else the other, else none (a plain grid).
 * A shown floor with vector art but no tiles (Interchange's upper floors) is drawn with the vector art even when tiles are preferred.
 */
export function artStyleOf(map: MapCalibration | null, preferred: ArtStyle = "svg", floor: FloorSelection = null): ArtStyle | null {
  if (!map) return null;
  const shown = floorById(map, floor);
  if (preferred === "tiles" && map.svg && shown && !shown.base && shown.svgLayer && !shown.tilePath) return "svg";
  if (map.svg && (preferred === "svg" || !map.tilePath)) return "svg";
  return map.tilePath ? "tiles" : map.svg ? "svg" : null;
}

/** Smallest "nice" world step (1/2/5 × 10ⁿ metres) that is at least `minPx` on screen. */
function gridStep(scale: number, minPx: number) {
  const raw = minPx / scale;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= raw) ?? power * 10;
}

export type TarkovMapHandle = {
  panTo(x: number, y: number): void;
  zoomBy(factor: number): void;
  /** Pans to a floor's column while floors are split (null: the whole map). */
  focusFloor(floor: string | null): void;
};

export type TarkovMapProps = {
  /** The map's calibration (`resolveMap`); null draws a plain metric grid. */
  map: MapCalibration | null;
  /** Preferred art; falls back to what the map has (see `artStyleOf`). */
  art?: ArtStyle;
  /** Floor shown (an id from `floorsOf`), or null for every floor. */
  floor: FloorSelection;
  /** Draws every floor side by side instead of stacked. */
  split?: boolean;
  /** Players to draw: older positions faded, the newest as a pointer. */
  players?: PlayerTrack[];
  /** Id of a track to keep centred on its newest position; dragging calls `onUserPan`, which should turn it off. */
  follow?: string | null;
  /** A point to centre on once, again whenever `key` changes; for jumping to something without following it. */
  centre?: { key: string; point: PlayerPosition } | null;
  onUserPan?: () => void;
  /** Overlay markers already filtered for display, with the filters they were filtered by (they pick icons). */
  markers?: MapMarker[];
  filters?: Filters;
  preset?: MarkerPreset;
  /** Item id to draw in place of a loose loot dot, by marker id. Keep referentially stable. */
  lootIcons?: Map<string, string>;
  /** Marker drawn as selected. */
  selected?: string | null;
  onMarkerHover?: (id: string | null) => void;
  onMarkerTap?: (id: string) => void;
  /** A tap off the markers, at its world x/z. Floors split apart are not accounted for. */
  onMapTap?: (point: WorldPoint) => void;
  className?: string;
  /** Drawn over the map, inside its frame. */
  children?: ReactNode;
  ref?: Ref<TarkovMapHandle>;
};

const noMarkers: MapMarker[] = [];
const noFilters: Filters = {};

/**
 * A pannable, zoomable Tarkov map: vector art or tiles by floor, data markers, and player positions.
 * Positions are world coordinates in the map's own space, so only pass players who are on this map.
 */
export function TarkovMap({ map, art: preferred = "svg", floor, split = false, players = [], follow = null, centre = null, onUserPan,
  markers = noMarkers, filters = noFilters, preset, lootIcons, selected, onMarkerHover, onMarkerTap, onMapTap, className, children, ref }: TarkovMapProps) {
  const projection = useMemo(() => map ? projectionFor(map) : metricProjection, [map]);
  const style = artStyleOf(map, preferred, floor);
  const art = useMemo((): PlaneRect | null => style === "svg" ? artRect(map!, projection) : style === "tiles" ? tileBounds(map!) : null, [map, style, projection]);
  const splitOn = split && style !== null;
  const layout = useSplitLayout(map, style, splitOn, art);
  const { shift } = layout;

  const markerFloors = useMemo(() => new Map(map ? markers.map((marker) => [marker.id, floorAt(map, marker.position).id]) : []), [markers, map]);
  const toPlane = (point: PlayerPosition) => {
    const plane = projection.toPlane(point);
    return { x: plane.x + (map && shift ? shift(floorAt(map, point).id, plane.x, plane.y) : 0), y: plane.y };
  };

  const markerAt = (target: Element) => target.closest<HTMLElement>("[data-marker]")?.dataset.marker ?? null;
  const viewport = useMapViewport({
    unitsPerMetre: projection.unitsPerMetre, zoomAroundCentre: !!follow, onPan: onUserPan,
    onTap: (target, at) => { const id = markerAt(target); if (id) onMarkerTap?.(id); else onMapTap?.(projection.toWorld(at)); },
  });
  const { view, size, toScreen, panTo, zoomAt } = viewport;

  const followed = players.find((track) => track.id === follow);
  const newest = followed?.positions.at(-1);
  const anyNewest = newest ?? players.find((track) => track.positions.length)?.positions.at(-1);

  // A different map means a different plane; start over once the frame has a size.
  const mapKey = map?.key ?? null;
  const shownMapKey = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (!size.width || shownMapKey.current === mapKey) return;
    shownMapKey.current = mapKey;
    viewport.reset(initialView(projection, art, anyNewest ? toPlane(anyNewest) : null, size));
  }, [mapKey, size.width > 0]);

  useEffect(() => {
    if (!newest) return;
    const { x, y } = toPlane(newest);
    panTo(x, y);
  }, [newest?.key, follow, panTo, projection, shift]);

  // After the reset above when the map changes, so a jump to another map lands on the point.
  useEffect(() => {
    if (!centre || !size.width) return;
    const { x, y } = toPlane(centre.point);
    panTo(x, y);
  }, [centre?.key, mapKey, size.width > 0]);

  useImperativeHandle(ref, () => ({
    panTo: (x, y) => panTo(x, y),
    zoomBy: (factor) => zoomAt(factor),
    focusFloor: (id) => { const point = layout.focus(id); if (point) panTo(point.x, point.y); },
  }), [panTo, zoomAt, layout.focus]);

  // Overlay markers are drawn a frame either side of the centre snapped to half frames, thinned for the zoom step;
  // panning or zooming only re-renders them when the snapped centre or the step changes.
  const zoomStep = Math.round(Math.log2(view.scale) * OVERLAY_ZOOM_STEPS);
  const stepScale = 2 ** (zoomStep / OVERLAY_ZOOM_STEPS);
  const reachX = size.width / stepScale, reachY = size.height / stepScale;
  const snapX = reachX ? Math.round(view.cx / (reachX / 2)) : 0, snapY = reachY ? Math.round(view.cy / (reachY / 2)) : 0;
  const overlayArea = useMemo((): OverlayArea | null => reachX && reachY
    ? { x: snapX * reachX / 2 - reachX, y: snapY * reachY / 2 - reachY, width: reachX * 2, height: reachY * 2, scale: stepScale }
    : null, [snapX, snapY, reachX, reachY, stepScale]);

  const pxPerMetre = view.scale * projection.unitsPerMetre;
  const minor = gridStep(pxPerMetre, 14) * pxPerMetre;
  const worldOrigin = projection.toPlane({ x: 0, z: 0 });
  const origin = toScreen(worldOrigin.x, worldOrigin.y);
  const gridStyle = {
    "--minor": `${minor}px`, "--major": `${minor * 5}px`,
    "--ox": `${origin.left}px`, "--oy": `${origin.top}px`,
  } as CSSProperties;

  const onPointerOver = (event: React.PointerEvent) => { if (!viewport.dragging()) onMarkerHover?.(markerAt(event.target as Element)); };
  const onPointerOut = (event: React.PointerEvent) => { if (!viewport.dragging() && markerAt(event.target as Element)) onMarkerHover?.(null); };

  return <div ref={viewport.frame} className={`map-canvas ${map ? "calibrated" : ""} ${className ?? ""}`} style={gridStyle}
    {...viewport.handlers} onPointerOver={onPointerOver} onPointerOut={onPointerOut}>
    {style === "svg" && art ? (() => {
      const corner = toScreen(art.x, art.y);
      return <MapArt map={map as MapCalibration & { svg: string }} floor={splitOn ? null : floor} split={splitOn} onSplit={layout.onSplit} className="map-art"
        style={{ transform: `translate(${corner.left}px, ${corner.top}px)`, width: art.width * view.scale, height: art.height * view.scale }} />;
    })() : style === "tiles" ? <MapTiles map={map as MapCalibration & { tilePath: string }} floor={splitOn ? null : floor}
      shifts={splitOn ? layout.columns : undefined} view={{ ...view, width: size.width, height: size.height }} /> : <>
      <div className="map-axis x" style={{ top: origin.top }} />
      <div className="map-axis y" style={{ left: origin.left }} />
    </>}
    <div className="overlay-layer" style={{
      transform: `translate(${size.width / 2 - view.cx * view.scale}px, ${size.height / 2 - view.cy * view.scale}px)`,
      "--s": view.scale,
    } as CSSProperties}>
      <MapOverlay markers={markers} filters={filters} preset={preset} projection={projection}
        floors={markerFloors} floor={splitOn ? null : floor} shift={shift} labelled={pxPerMetre >= LABEL_PX_PER_M} area={overlayArea}
        selected={selected} lootIcons={lootIcons} />
      {layout.labels.length > 0 && <div className="split-labels">
        {layout.labels.map((label) => label.width * view.scale >= SPLIT_LABEL_MIN_PX && <span key={label.floor} className="split-label"
          style={{ left: `calc(${label.x}px * var(--s))`, top: `calc(${label.y}px * var(--s))`, maxWidth: label.width * view.scale }}>{label.name}</span>)}
      </div>}
    </div>
    <PlayerMarkers players={players} at={(position) => { const { x, y } = toPlane(position); return toScreen(x, y); }} heading={projection.heading} />
    {children}
  </div>;
}

/** Older positions fade by age in their track; the newest is a pointer, glowing while its track is live. */
function PlayerMarkers({ players, at, heading }: {
  players: PlayerTrack[]; at: (position: PlayerPosition) => { left: number; top: number }; heading: (degrees: number) => number;
}) {
  const live = players.some((track) => track.live);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [live]);
  const title = (position: PlayerPosition) => position.at ? new Date(position.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : undefined;
  const rotation = (position: PlayerPosition) => position.heading == null ? null : heading(position.heading);
  return <>{players.map((track) => {
    const newest = track.positions.at(-1);
    const older = track.positions.slice(0, -1);
    const colour = track.color ? { "--player": track.color } : {};
    return <div key={track.id} className={`player-track ${track.className ?? ""}`} style={colour as CSSProperties}>
      {older.map((position, index) => <Marker key={position.key} at={at(position)} heading={rotation(position)}
        className="marker old" style={{ opacity: 0.18 + (index + 1) / (older.length + 1) * 0.4 } as CSSProperties} title={title(position)} />)}
      {newest && <Marker at={at(newest)} heading={rotation(newest)} className="marker newest" badge={track.badge}
        style={{ "--fresh": track.live && newest.at ? freshness(newest.at, now) : 0 } as CSSProperties}
        title={[track.label, title(newest)].filter(Boolean).join(" · ") || undefined} />}
    </div>;
  })}</>;
}

function Marker({ at, heading, className, style, title, badge }: {
  at: { left: number; top: number }; heading: number | null; className: string; style?: CSSProperties; title?: string; badge?: string;
}) {
  // The sharp corner sits top-left; +45° turns it to "up", then heading rotates clockwise from screen up.
  const pointer = heading !== null;
  return <div className={`${className} ${pointer ? "pointer" : ""}`} title={title}
    style={{ ...style, left: at.left, top: at.top, "--rot": `${(heading ?? 0) + 45}deg` } as CSSProperties}>
    {badge && <span className="marker-badge">{badge}</span>}
  </div>;
}
