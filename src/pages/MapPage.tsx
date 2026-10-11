import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Scanner } from "../lib/useScanner";
import { freshness, positionsForRaid, toPlane } from "../lib/positions";
import { age, clock } from "../lib/format";
import { useNow } from "../lib/useNow";
import { CrosshairIcon, MinusIcon, PlusIcon } from "../components/Icons";

type View = { cx: number; cy: number; scale: number };
const MIN_SCALE = 0.05, MAX_SCALE = 40;
const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

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

  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>(() => {
    const start = newest ? toPlane(newest) : { x: 0, y: 0 };
    return { cx: start.x, cy: start.y, scale: 2 };
  });
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

  const newestKey = newest ? `${newest.filename}|${newest.observed_at}` : null;
  useEffect(() => {
    if (!follow || !newest) return;
    const { x, y } = toPlane(newest);
    panTo(x, y);
  }, [newestKey, follow, panTo]);
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
    const scale = clampScale(current.scale * factor);
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

  const minor = gridStep(view.scale, 14) * view.scale;
  const major = minor * 5;
  const origin = toScreen(0, 0);
  const gridStyle = {
    "--minor": `${minor}px`, "--major": `${major}px`,
    "--ox": `${origin.left}px`, "--oy": `${origin.top}px`,
  } as CSSProperties;

  const fresh = newest ? freshness(newest.observed_at, now) : 0;
  const status = !desktop ? "preview" : connected ? "online" : "offline";

  return <div className="map-page">
    <div ref={frame} className="map-canvas" style={gridStyle}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onWheel={onWheel} onDoubleClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        zoomAt(2, event.clientX - rect.left, event.clientY - rect.top);
      }}>
      <div className="map-axis x" style={{ top: origin.top }} />
      <div className="map-axis y" style={{ left: origin.left }} />
      {markers.slice(0, -1).map((position, index, older) => {
        const { x, y } = toPlane(position);
        const recency = (index + 1) / (older.length + 1);
        return <Marker key={`${position.filename}|${position.observed_at}`} at={toScreen(x, y)} heading={position.heading_degrees}
          className="marker old" style={{ opacity: 0.18 + recency * 0.4 } as CSSProperties} title={clock(position.observed_at)} />;
      })}
      {newest && (() => {
        const { x, y } = toPlane(newest);
        return <Marker at={toScreen(x, y)} heading={newest.heading_degrees} className="marker newest"
          style={{ "--fresh": fresh } as CSSProperties} title={clock(newest.observed_at)} />;
      })()}
      {!newest && <p className="map-empty">Take a screenshot in raid to place a position</p>}
    </div>

    <div className={`map-chip ${status}`}>
      <span className="dot" />
      {raid?.map ?? (status === "online" ? "No map" : status === "offline" ? "Disconnected" : "Preview")}
    </div>

    <div className="map-tools">
      <button type="button" className={`icon-button ${follow ? "active" : ""}`} aria-pressed={follow}
        title="Follow newest position" onClick={() => setFollow((value) => !value)}><CrosshairIcon /></button>
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
  // The sharp corner sits top-left; +45° turns it to "up", then heading rotates clockwise from world +Z.
  const pointer = heading !== null;
  return <div className={`${className} ${pointer ? "pointer" : ""}`} title={title}
    style={{ ...style, left: at.left, top: at.top, "--rot": `${(heading ?? 0) + 45}deg` } as CSSProperties} />;
}
