import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Scanner } from "../lib/useScanner";
import { freshness, positionsForRaid } from "../lib/positions";
import type { PositionObservation } from "../bindings/PositionObservation";
import { artRect, floorAt, MapArt, MapTiles, mapName, metricProjection, projectionFor, resolveMap, tileBounds, type MapProjection, type PlaneRect } from "../maps";
import { tileUrl } from "../lib/tiles";
import { keys, load, save } from "../lib/persist";
import { age, clock } from "../lib/format";
import { useNow } from "../lib/useNow";
import { CrosshairIcon, LayersIcon, MinusIcon, PlusIcon } from "../components/Icons";

/** Centre in plane units; scale in screen pixels per plane unit. */
type View = { cx: number; cy: number; scale: number };
/** Zoom limits and default in screen pixels per world metre. */
const MIN_PX_PER_M = 0.05, MAX_PX_PER_M = 40, DEFAULT_PX_PER_M = 2;
const clampScale = (scale: number, unitsPerMetre: number) =>
  Math.min(MAX_PX_PER_M, Math.max(MIN_PX_PER_M, scale * unitsPerMetre)) / unitsPerMetre;

type ArtStyle = "svg" | "tiles";

const world = (position: PositionObservation) => ({ x: position.xyz[0], y: position.xyz[1], z: position.xyz[2] });

/** Newest position at the default zoom, else the whole map, else the world origin. */
function initialView(projection: MapProjection, art: PlaneRect | null, newest: PositionObservation | undefined, size: { width: number; height: number }): View {
  if (newest) {
    const { x, y } = projection.toPlane(world(newest));
    return { cx: x, cy: y, scale: DEFAULT_PX_PER_M / projection.unitsPerMetre };
  }
  if (art && size.width && size.height) {
    const scale = clampScale(Math.min(size.width / art.width, size.height / art.height) * 0.92, projection.unitsPerMetre);
    return { cx: art.x + art.width / 2, cy: art.y + art.height / 2, scale };
  }
  const origin = projection.toPlane({ x: 0, z: 0 });
  return { cx: origin.x, cy: origin.y, scale: DEFAULT_PX_PER_M / projection.unitsPerMetre };
}

/** Smallest "nice" world step (1/2/5 × 10ⁿ metres) that is at least `minPx` on screen. */
function gridStep(scale: number, minPx: number) {
  const raw = minPx / scale;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= raw) ?? power * 10;
}

export function MapPage({ scanner }: { scanner: Scanner }) {
  const { snapshot, positions, connected, desktop } = scanner;
  const now = useNow(500);
  const raid = snapshot?.raid;
  const raidId = raid && raid.lifecycle !== "unknown" ? raid.id : null;
  const markers = positionsForRaid(positions, raidId);
  const newest = markers[markers.length - 1];

  const calibration = resolveMap(raid?.map);
  const projection = useMemo(() => calibration ? projectionFor(calibration) : metricProjection, [calibration]);
  // Vector art by default; tiles when chosen or when the map has no vector art.
  const [preferred, setPreferred] = useState<ArtStyle>(() => load(keys.mapStyle, "svg"));
  useEffect(() => save(keys.mapStyle, preferred), [preferred]);
  const svgMap = calibration?.svg ? calibration as typeof calibration & { svg: string } : null;
  const tileMap = calibration?.tilePath ? calibration as typeof calibration & { tilePath: string } : null;
  const style: ArtStyle | null = svgMap && (preferred === "svg" || !tileMap) ? "svg" : tileMap ? "tiles" : null;
  const art = useMemo(() => svgMap ? artRect(svgMap, projection) : tileMap ? tileBounds(tileMap) : null, [calibration, projection]);
  const toPlane = (position: PositionObservation) => projection.toPlane(world(position));
  const floor = calibration && newest ? floorAt(calibration, world(newest)) : null;

  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>(() => initialView(projection, art, newest, size));
  const viewRef = useRef(view);
  viewRef.current = view;
  const [follow, setFollow] = useState(true);
  const tween = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const stopTween = () => { if (tween.current !== null) cancelAnimationFrame(tween.current); tween.current = null; };

  const panTo = useCallback((x: number, y: number, duration = 650) => {
    stopTween();
    const start = viewRef.current;
    const begin = performance.now();
    const step = (time: number) => {
      const t = Math.min(1, (time - begin) / duration);
      const e = 1 - (1 - t) ** 3;
      setView((current) => ({ ...current, cx: start.cx + (x - start.cx) * e, cy: start.cy + (y - start.cy) * e }));
      tween.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    tween.current = requestAnimationFrame(step);
  }, []);

  // A different map means a different plane; start over once the frame has a size.
  const mapKey = calibration?.key ?? null;
  const shownMap = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (!size.width || shownMap.current === mapKey) return;
    shownMap.current = mapKey;
    stopTween();
    setView(initialView(projection, art, newest, size));
  }, [mapKey, size.width > 0]);

  const newestKey = newest ? `${newest.filename}|${newest.observed_at}` : null;
  useEffect(() => {
    if (!follow || !newest) return;
    const { x, y } = toPlane(newest);
    panTo(x, y);
  }, [newestKey, follow, panTo, projection]);
  useEffect(() => stopTween, []);

  const toScreen = (x: number, y: number) => ({
    left: (x - view.cx) * view.scale + size.width / 2,
    top: (y - view.cy) * view.scale + size.height / 2,
  });

  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y;
    if (!dx && !dy) return;
    drag.current = { x: event.clientX, y: event.clientY };
    stopTween();
    setFollow(false);
    setView((current) => ({ ...current, cx: current.cx - dx / current.scale, cy: current.cy - dy / current.scale }));
  };
  const onPointerUp = () => { drag.current = null; };

  const zoomAt = (factor: number, sx = size.width / 2, sy = size.height / 2) => setView((current) => {
    const scale = clampScale(current.scale * factor, projection.unitsPerMetre);
    const wx = current.cx + (sx - size.width / 2) / current.scale;
    const wy = current.cy + (sy - size.height / 2) / current.scale;
    return { scale, cx: wx - (sx - size.width / 2) / scale, cy: wy - (sy - size.height / 2) / scale };
  });
  const onWheel = (event: React.WheelEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // Zooming around the cursor moves the centre; keep following only when zooming around the centre.
    if (follow) zoomAt(Math.exp(-event.deltaY * 0.0015));
    else zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
  };

  const pxPerMetre = view.scale * projection.unitsPerMetre;
  const minor = gridStep(pxPerMetre, 14) * pxPerMetre;
  const major = minor * 5;
  const worldOrigin = projection.toPlane({ x: 0, z: 0 });
  const origin = toScreen(worldOrigin.x, worldOrigin.y);
  const gridStyle = {
    "--minor": `${minor}px`, "--major": `${major}px`,
    "--ox": `${origin.left}px`, "--oy": `${origin.top}px`,
  } as CSSProperties;

  const heading = (position: PositionObservation) =>
    position.heading_degrees === null ? null : projection.heading(position.heading_degrees);

  const fresh = newest ? freshness(newest.observed_at, now) : 0;
  const status = !desktop ? "preview" : connected ? "online" : "offline";

  return <div className="map-page">
    <div ref={frame} className={`map-canvas ${calibration ? "calibrated" : ""}`} style={gridStyle}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onWheel={onWheel} onDoubleClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        zoomAt(2, event.clientX - rect.left, event.clientY - rect.top);
      }}>
      {style === "svg" && svgMap && art ? (() => {
        const corner = toScreen(art.x, art.y);
        return <MapArt map={svgMap} floor={floor?.svgLayer ?? null} className="map-art"
          style={{ left: corner.left, top: corner.top, width: art.width * view.scale, height: art.height * view.scale }} />;
      })() : style === "tiles" && tileMap ? <MapTiles map={tileMap} floor={floor} tileUrl={tileUrl}
        view={{ ...view, width: size.width, height: size.height }} /> : <>
        <div className="map-axis x" style={{ top: origin.top }} />
        <div className="map-axis y" style={{ left: origin.left }} />
      </>}
      {markers.slice(0, -1).map((position, index, older) => {
        const { x, y } = toPlane(position);
        const recency = (index + 1) / (older.length + 1);
        return <Marker key={`${position.filename}|${position.observed_at}`} at={toScreen(x, y)} heading={heading(position)}
          className="marker old" style={{ opacity: 0.18 + recency * 0.4 } as CSSProperties} title={clock(position.observed_at)} />;
      })}
      {newest && (() => {
        const { x, y } = toPlane(newest);
        return <Marker at={toScreen(x, y)} heading={heading(newest)} className="marker newest"
          style={{ "--fresh": fresh } as CSSProperties} title={clock(newest.observed_at)} />;
      })()}
      {!newest && <p className="map-empty">Take a screenshot in raid to place a position</p>}
    </div>

    <div className={`map-chip ${status}`}>
      <span className="dot" />
      {mapName(raid?.map) ?? (status === "online" ? "No map" : status === "offline" ? "Disconnected" : "Preview")}
      {floor && <span className="faint">{floor.name}</span>}
    </div>

    <div className="map-tools">
      <button type="button" className={`icon-button ${follow ? "active" : ""}`} aria-pressed={follow}
        title="Follow newest position" onClick={() => setFollow((value) => !value)}><CrosshairIcon /></button>
      {svgMap && tileMap && <button type="button" className={`icon-button ${style === "tiles" ? "active" : ""}`}
        aria-pressed={style === "tiles"} title={style === "tiles" ? "Show vector map" : "Show detailed tiles"}
        onClick={() => setPreferred(style === "tiles" ? "svg" : "tiles")}><LayersIcon /></button>}
      <button type="button" className="icon-button" title="Zoom in" onClick={() => zoomAt(1.5)}><PlusIcon /></button>
      <button type="button" className="icon-button" title="Zoom out" onClick={() => zoomAt(1 / 1.5)}><MinusIcon /></button>
      {newest && <span className="map-readout">
        <span>X {newest.xyz[0].toFixed(1)}</span><span>Z {newest.xyz[2].toFixed(1)}</span>
        <span className="faint">{age(newest.observed_at, now)} ago</span>
      </span>}
    </div>
  </div>;
}

function Marker({ at, heading, className, style, title }: {
  at: { left: number; top: number }; heading: number | null; className: string; style?: CSSProperties; title?: string;
}) {
  // The sharp corner sits top-left; +45° turns it to "up", then heading rotates clockwise from screen up.
  const pointer = heading !== null;
  return <div className={`${className} ${pointer ? "pointer" : ""}`} title={title}
    style={{ ...style, left: at.left, top: at.top, "--rot": `${(heading ?? 0) + 45}deg` } as CSSProperties} />;
}
