import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { Scanner } from "../lib/useScanner";
import { keys, usePersisted } from "../lib/persist";
import {
  copyRoom, dataRooms, guessAt, inRoom, tenth, roomBox, roomCorners, roomRings, useFloorData,
  type DataRoom, type FloorRoom, type RoomRect, type RoomShape,
} from "../lib/floorData";
import {
  artStyleOf, floorsOf, games, levelText, MapAssetsContext, maps as calibrations, resolveGame, resolveMap, TarkovMap,
  type ArtStyle, type FloorSelection, type MapDrawView, type PlayerPosition, type WorldArea,
} from "../maps";
import { appAssets } from "../lib/tiles";
import { TerrainIcon } from "../components/Icons";
import { shotMap } from "./ShotsPage";

/** Floor colours by the floor's place in `floorsOf`. */
const PALETTE = ["#f2c14e", "#4fd18b", "#58a6ff", "#ff7b72", "#d2a8ff", "#39d0d8", "#ffa657", "#e6edf3"];
const NEW_ID = () => Math.random().toString(36).slice(2, 10);
/** Smallest room a drag draws (m); anything less is a click. */
const MIN_SIZE = 0.5;
/** Outlines with more points than this get no point handles: too dense to drag one by one (Streets' footprints run to thousands). */
const MAX_HANDLES = 60;
/** Rotation handle distance past the room's edge (px). */
const ROTATE_PX = 22;
const round = (value: number, step = 0.01) => Math.round(value / step) * step;

/** A position on this map: a labelled sample, or a capture in history not labelled yet. */
type Dot = { id: string; x: number; y: number; z: number; floor: string | null; guess: string; inHistory: boolean };

/** The room picked: one in the dataset (editable), or one in the app's floor data (shown as is until copied). */
type Selection = { kind: "drawn"; id: string } | { kind: "data"; key: string } | null;

type Drag =
  | { kind: "draw"; start: { x: number; z: number } }
  | { kind: "move"; start: { x: number; z: number }; room: FloorRoom }
  | { kind: "corner"; opposite: [number, number]; rect: RoomRect }
  | { kind: "rotate"; from: number; rect: RoomRect }
  | { kind: "vertex"; ring: number; index: number; area: WorldArea };

const moved = (room: FloorRoom, dx: number, dz: number): FloorRoom => room.rect
  ? { ...room, rect: { ...room.rect, x: room.rect.x + dx, z: room.rect.z + dz } }
  : { ...room, area: (room.area ?? []).map((ring) => ring.map(([x, z]): [number, number] => [x + dx, z + dz])) };

const sameSelection = (a: Selection, b: Selection) => !!a && !!b && (a.kind === "drawn" ? b.kind === "drawn" && a.id === b.id : b.kind === "data" && a.key === b.key);

/**
 * Dev: a map's floor dataset (src/lib/floorData.ts) over its art: every capture on the map with its height (Y), coloured by
 * the floor it is labelled with (hollow until labelled, ringed red where the dataset's rooms put it on another floor), and rooms: those drawn
 * or copied into the dataset, and, dashed, those in the app's floor data. Tapping the map picks the room there (again: the
 * next one under it). Nothing here changes the floor data the app uses.
 */
export function FloorsPage({ scanner, onOpenShot }: { scanner: Scanner; onOpenShot: (filename: string) => void }) {
  const mapOptions = useMemo(() => games.filter((game) => game.art && calibrations[game.art]), []);
  const newestMap = scanner.positions.length ? resolveGame(shotMap(scanner, scanner.positions[scanner.positions.length - 1]))?.key ?? null : null;
  const [stored, setStored] = usePersisted<string | null>(keys.floorsMap, null);
  const mapKey = stored ?? newestMap ?? "streets-of-tarkov";
  const map = resolveMap(mapKey);
  const floorData = useFloorData(mapKey);
  const data = floorData.data;
  const floors = map ? floorsOf(map) : [];
  // Bottom to top: `floorsOf` lists the base first, so underground floors (Customs lists its last) go before it.
  const stack = [...floors.filter((floor) => floor.underground), ...floors.filter((floor) => !floor.underground)];
  const colour = (floor: string | null) => floor === null ? undefined : PALETTE[Math.max(0, floors.findIndex((other) => other.id === floor)) % PALETTE.length];
  const floorName = (id: string) => floors.find((other) => other.id === id)?.name ?? id;
  const [shown, setShown] = useState<FloorSelection>(null);
  useEffect(() => setShown(null), [mapKey]);
  const visible = (floor: string) => shown === null || floor === shown;
  // Vector art or the detailed tiles, kept apart from the Map page's choice.
  const [preferred, setPreferred] = usePersisted<ArtStyle>(keys.floorsStyle, "svg");
  const style = artStyleOf(map, preferred);
  const bothStyles = !!(map?.svg && map.tilePath);

  const rooms = data?.rooms ?? [];
  const dots = useMemo((): Dot[] => {
    if (!map) return [];
    const inHistory = new Set<string>();
    const labelled = new Map((data?.samples ?? []).map((sample) => [sample.id, sample]));
    const result: Dot[] = [];
    for (const shot of scanner.positions) {
      if (resolveGame(shotMap(scanner, shot))?.key !== mapKey) continue;
      inHistory.add(shot.filename);
      if (labelled.has(shot.filename)) continue;
      const [x, y, z] = shot.xyz;
      result.push({ id: shot.filename, x, y, z, floor: null, guess: guessAt(map, rooms, { x, y, z }).floor, inHistory: true });
    }
    // Labels are checked against the rooms as they are now, so adjusting a room shows what it fixes or breaks.
    for (const sample of labelled.values()) result.push({ ...sample, guess: guessAt(map, rooms, sample).floor, inHistory: inHistory.has(sample.id) });
    return result;
  }, [map, mapKey, scanner.positions, scanner.raids, scanner.snapshot?.raid, data, rooms]);
  const shownDots = dots.filter((dot) => visible(dot.floor ?? dot.guess));
  const labelled = dots.filter((dot) => dot.floor !== null);
  const right = labelled.filter((dot) => dot.floor === dot.guess).length;

  const [showData, setShowData] = usePersisted(keys.floorsDataRooms, true);
  // Floor data rooms copied into the dataset show as their copy only.
  const copied = new Set(rooms.map((room) => room.source).filter(Boolean));
  const originals = useMemo(() => map ? dataRooms(map) : [], [map]);
  const shownData = showData ? originals.filter((room) => !copied.has(room.key) && visible(room.floor)) : [];
  const shownRooms = rooms.filter((room) => visible(room.floor));

  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => setSelection(null), [mapKey]);
  const room = selection?.kind === "drawn" ? rooms.find((other) => other.id === selection.id) ?? null : null;
  const original = selection?.kind === "data" ? originals.find((other) => other.key === selection.key) ?? null : null;
  const picked: (RoomShape & { floor: string }) | null = room ?? original;
  const zones = [...new Set([...rooms.map((other) => other.zone), ...(data?.samples ?? []).map((sample) => sample.zone)].filter((name): name is string => !!name))].sort();
  const [drawing, setDrawing] = useState(false);
  const [centre, setCentre] = useState<{ key: string; point: PlayerPosition } | null>(null);
  useEffect(() => {
    if (!drawing && !selection) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches("input, select, textarea")) return;
      if (event.key === "Escape") { setDrawing(false); setSelection(null); }
      else if (event.key === "Delete" && room) { floorData.removeRoom(room.id); setSelection(null); }
      else if (event.key === "d" && (event.ctrlKey || event.metaKey) && room) { event.preventDefault(); duplicate(room); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** A tap picks the room under it, dataset rooms first; tapping again goes to the next one there. */
  const tap = (point: { x: number; z: number }) => {
    const under: Selection[] = [
      ...shownRooms.filter((other) => inRoom(other, point)).map((other): Selection => ({ kind: "drawn", id: other.id })),
      ...shownData.filter((other) => inRoom(other, point)).map((other): Selection => ({ kind: "data", key: other.key })),
    ];
    const at = under.findIndex((other) => sameSelection(other, selection));
    setSelection(under.length ? under[(at + 1) % under.length] : null);
  };
  const copy = (source: DataRoom) => {
    const next = copyRoom(source);
    floorData.setRoom(next);
    setSelection({ kind: "drawn", id: next.id });
  };
  /**
   * The same shape one floor up, for stacking a building's floors: it starts where this one ends (Y from = this Y to) and
   * is open above. It is a new room of its own, not a copy of floor data.
   */
  const duplicate = (from: FloorRoom) => {
    const at = stack.findIndex((other) => other.id === from.floor);
    const floor = stack[Math.min(at + 1, stack.length - 1)]?.id ?? from.floor;
    const { source: _source, ...rest } = from;
    const next: FloorRoom = {
      ...rest, id: NEW_ID(), floor, heightSource: "manual", height: [from.height[1], null],
      rect: from.rect && { ...from.rect }, area: from.area?.map((ring) => ring.map(([x, z]): [number, number] => [x, z])),
    };
    floorData.setRoom(next);
    setSelection({ kind: "drawn", id: next.id });
    if (shown !== null) setShown(floor);
  };

  // While a room is dragged it is drawn from here and saved once on release.
  const [draft, setDraft] = useState<FloorRoom | null>(null);
  const drag = useRef<Drag | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const lastZone = useRef("");

  const draw = (view: MapDrawView) => {
    const at = (event: ReactPointerEvent) => {
      const rect = layer.current!.getBoundingClientRect();
      return view.toWorld(event.clientX - rect.left, event.clientY - rect.top);
    };
    const begin = (event: ReactPointerEvent, next: Drag) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
      drag.current = next;
    };
    const move = (event: ReactPointerEvent) => {
      const current = drag.current;
      if (!current) return;
      const point = at(event);
      if (current.kind === "draw") {
        const { start } = current;
        setDraft({ id: NEW_ID(), zone: lastZone.current, floor: shown ?? floors[0]?.id ?? "ground", height: [null, null], heightSource: "manual",
          rect: { x: (start.x + point.x) / 2, z: (start.z + point.z) / 2, width: Math.abs(point.x - start.x), depth: Math.abs(point.z - start.z), angle: 0 } });
      } else if (current.kind === "move") {
        setDraft(moved(current.room, point.x - current.start.x, point.z - current.start.z));
      } else if (current.kind === "corner" && room) {
        const { rect, opposite: [ox, oz] } = current;
        const cos = Math.cos(rect.angle * Math.PI / 180), sin = Math.sin(rect.angle * Math.PI / 180);
        const dx = point.x - ox, dz = point.z - oz, u = dx * cos + dz * sin, v = -dx * sin + dz * cos;
        setDraft({ ...room, rect: { ...rect, x: ox + (u * cos - v * sin) / 2, z: oz + (u * sin + v * cos) / 2, width: Math.abs(u), depth: Math.abs(v) } });
      } else if (current.kind === "rotate" && room) {
        const { rect } = current;
        const turn = Math.atan2(point.z - rect.z, point.x - rect.x) * 180 / Math.PI - current.from;
        const angle = ((rect.angle + turn) % 360 + 540) % 360 - 180;
        setDraft({ ...room, rect: { ...rect, angle: event.shiftKey ? Math.round(angle / 15) * 15 : round(angle, 0.5) } });
      } else if (current.kind === "vertex" && room) {
        const area = current.area.map((ring, index) => index !== current.ring ? ring
          : ring.map((vertex, at): [number, number] => at === current.index ? [point.x, point.z] : vertex));
        setDraft({ ...room, area });
      }
    };
    const end = () => {
      const current = drag.current;
      drag.current = null;
      if (!current) return;
      const big = !!draft?.rect && draft.rect.width >= MIN_SIZE && draft.rect.depth >= MIN_SIZE;
      if (draft && (current.kind !== "draw" || big)) {
        floorData.setRoom(draft);
        setSelection({ kind: "drawn", id: draft.id });
      }
      if (current.kind === "draw") setDrawing(false);
      setDraft(null);
    };
    const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };
    const path = (shape: RoomShape) => roomRings(shape).map((ring) => `M${ring.map(([x, z]) => {
      const point = view.toScreen({ x, z });
      return `${point.left.toFixed(1)} ${point.top.toFixed(1)}`;
    }).join("L")}Z`).join("");
    const shape = (target: FloorRoom) => draft?.id === target.id ? draft : target;
    const listed = draft && !rooms.some((other) => other.id === draft.id) ? [...shownRooms, draft] : shownRooms;
    const label = (target: RoomShape & { zone: string; floor: string; height: [number | null, number | null] }, key: string, className = "") => {
      const point = view.toScreen(roomBox(target));
      return <span key={key} className={`floors-room-label ${className}`} style={{ left: point.left, top: point.top }}>
        {target.zone || "Unnamed"}<br />{floorName(target.floor)} · {heightText(target.height)}
      </span>;
    };

    return <div ref={layer} className={`floors-layer ${drawing ? "drawing" : ""}`}
      onPointerDown={drawing ? (event) => begin(event, { kind: "draw", start: at(event) }) : undefined} {...drawing ? handlers : {}}>
      <svg className="floors-rooms">
        {shownData.map((target) => <path key={target.key} className={`data ${original === target ? "selected" : ""}`}
          style={{ "--floor": colour(target.floor) } as CSSProperties} d={path(target)} />)}
        {listed.map((target) => <path key={target.id} className={`${target === room ? "selected" : ""} ${shape(target).rect?.angle ? "rotated" : ""}`}
          style={{ "--floor": colour(shape(target).floor) } as CSSProperties} d={path(shape(target))}
          onPointerDown={!drawing && target === room ? (event) => begin(event, { kind: "move", start: at(event), room: target }) : undefined}
          {...!drawing && target === room ? handlers : {}} />)}
      </svg>
      {original && label(original, original.key, "data")}
      {listed.map((target) => label(shape(target), target.id))}
      {room && !drawing && (() => {
        const current = shape(room);
        if (!current.rect || !room.rect) {
          const area = room.area ?? [];
          if (area.flat().length > MAX_HANDLES) return null;
          return (current.area ?? []).map((ring, ringAt) => ring.map(([x, z], index) => {
            const point = view.toScreen({ x, z });
            return <span key={`${ringAt}:${index}`} className="floors-handle corner" style={{ left: point.left, top: point.top }}
              onPointerDown={(event) => begin(event, { kind: "vertex", ring: ringAt, index, area })} {...handlers} />;
          }));
        }
        const rect = room.rect, corners = roomCorners(current.rect), points = corners.map(([x, z]) => view.toScreen({ x, z }));
        // The rotation handle sits past the middle of the room's first edge.
        const [[ax, az], [bx, bz]] = corners, mid = view.toScreen({ x: (ax + bx) / 2, z: (az + bz) / 2 }), centreAt = view.toScreen(current.rect);
        const away = Math.hypot(mid.left - centreAt.left, mid.top - centreAt.top) || 1;
        const knob = { left: mid.left + (mid.left - centreAt.left) / away * ROTATE_PX, top: mid.top + (mid.top - centreAt.top) / away * ROTATE_PX };
        return <>
          {points.map((point, index) => <span key={index} className="floors-handle corner" style={{ left: point.left, top: point.top }}
            onPointerDown={(event) => begin(event, { kind: "corner", opposite: roomCorners(rect)[(index + 2) % 4], rect })} {...handlers} />)}
          <span className="floors-handle rotate" style={{ left: knob.left, top: knob.top }} title="Rotate (Shift: 15° steps)"
            onPointerDown={(event) => { const point = at(event); begin(event, { kind: "rotate", from: Math.atan2(point.z - rect.z, point.x - rect.x) * 180 / Math.PI, rect }); }}
            {...handlers} />
        </>;
      })()}
      {shownDots.map((dot) => {
        const point = view.toScreen(dot);
        return <button key={dot.id} type="button" className={`floors-dot ${dot.floor === null ? "unlabelled" : ""} ${dot.floor !== null && dot.floor !== dot.guess ? "wrong" : ""}`}
          style={{ left: point.left, top: point.top, "--floor": colour(dot.floor ?? dot.guess) } as CSSProperties}
          title={[dot.floor === null ? `Not labelled · guess ${floorName(dot.guess)}` : `${floorName(dot.floor)}${dot.floor !== dot.guess ? ` · guess was ${floorName(dot.guess)}` : ""}`,
            `X ${dot.x.toFixed(2)} Y ${dot.y.toFixed(2)} Z ${dot.z.toFixed(2)}`, dot.inHistory ? "Click to open in Shots" : "No longer in history"].join("\n")}
          onPointerDown={(event) => event.stopPropagation()} onClick={() => { if (dot.inHistory) onOpenShot(dot.id); }}>
          <span>{dot.y.toFixed(1)}</span>
        </button>;
      })}
    </div>;
  };

  const inside = picked ? labelled.filter((dot) => inRoom(picked, dot)) : [];
  const place = (id: string) => stack.findIndex((other) => other.id === id);
  const onFloor = inside.filter((dot) => dot.floor === picked?.floor).map((dot) => dot.y);
  const below = inside.filter((dot) => picked && place(dot.floor!) < place(picked.floor)).map((dot) => dot.y);
  const above = inside.filter((dot) => picked && place(dot.floor!) > place(picked.floor)).map((dot) => dot.y);
  const hints = <p className="faint">
    {onFloor.length ? `On this floor: ${onFloor.length}, Y ${Math.min(...onFloor).toFixed(2)} – ${Math.max(...onFloor).toFixed(2)}` : "No labelled shots on this floor here"}
    {below.length ? <><br />Highest below: {Math.max(...below).toFixed(2)}</> : null}
    {above.length ? <><br />Lowest above: {Math.min(...above).toFixed(2)}</> : null}
  </p>;
  const edit = (patch: Partial<FloorRoom>) => {
    if (!room) return;
    if (patch.zone !== undefined) lastZone.current = patch.zone;
    floorData.setRoom({ ...room, ...patch });
  };
  const editRect = (patch: Partial<RoomRect>) => { if (room?.rect) edit({ rect: { ...room.rect, ...patch } }); };
  const source = room?.source ? originals.find((other) => other.key === room.source) ?? null : null;

  return <MapAssetsContext.Provider value={appAssets}><div className="floors-page">
    <div className="floors-map">
      <TarkovMap map={map} art={preferred} floor={shown} centre={centre} draw={draw} onMapTap={tap} />
      <div className="map-tools floors-tools">
        <button type="button" className={`icon-button ${style === "tiles" ? "active" : ""}`} aria-pressed={style === "tiles"} disabled={!bothStyles}
          title={!bothStyles ? "Only one map style for this map" : style === "tiles" ? "Show vector map" : "Show detailed tiles"}
          onClick={() => setPreferred(style === "tiles" ? "svg" : "tiles")}><TerrainIcon /></button>
      </div>
    </div>
    <aside className="floors-side">
      <select value={mapKey} onChange={(event) => setStored(event.target.value)}>
        {mapOptions.map((game) => <option key={game.key} value={game.key}>{game.name}</option>)}
      </select>
      <p className="faint">{labelled.length} labelled · {dots.length - labelled.length} not{labelled.length ? ` · guess right ${Math.round(right / labelled.length * 100)}%` : ""}</p>
      {floorData.error && <p className="shots-error">{floorData.error}</p>}

      <div className="floors-floors">
        <button type="button" className={shown === null ? "chosen" : ""} onClick={() => setShown(null)}>All</button>
        {floors.map((option) => <button key={option.id} type="button" className={shown === option.id ? "chosen" : ""}
          style={{ "--floor": colour(option.id) } as CSSProperties} onClick={() => setShown(option.id)}><i />{option.name}</button>)}
      </div>
      <label className="floors-check"><input type="checkbox" checked={showData} onChange={(event) => setShowData(event.target.checked)} />
        Floor data rooms ({originals.length - copied.size})</label>

      <h2>Rooms <button type="button" className={`secondary ${drawing ? "chosen" : ""}`} disabled={!map} onClick={() => { setDrawing(!drawing); setSelection(null); }}>
        {drawing ? "Drag on the map…" : "Draw room"}</button></h2>

      {original ? <div className="floors-room">
        <p><strong>{original.zone || "Unnamed"}</strong><br /><span className="faint">In the floor data · {floorName(original.floor)} · {heightText(original.height)}
          <br />{original.rect ? "Box" : `Outline · ${roomRings(original).flat().length} points`}</span></p>
        {hints}
        <div className="floors-actions">
          <button type="button" className="secondary" onClick={() => setSelection(null)}>Close</button>
          <button type="button" className="secondary" onClick={() => copy(original)}>Edit as copy</button>
        </div>
      </div> : room ? <div className="floors-room">
        {room.source && <p className="faint">Copy of floor data{source ? ` (${floorName(source.floor)} · ${heightText(source.height)})` : " (original no longer there)"}</p>}
        <label>Zone<input list="floors-zones" value={room.zone} placeholder="Building or room" onChange={(event) => edit({ zone: event.target.value })} /></label>
        <datalist id="floors-zones">{zones.map((option) => <option key={option} value={option} />)}</datalist>
        <label>Floor<select value={room.floor} onChange={(event) => edit({ floor: event.target.value })}>
          {floors.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select></label>
        <div className="floors-pair">
          <NumberField label="Y from" value={room.height[0]} onChange={(value) => edit({ height: [value === null ? null : tenth(value), room.height[1]] })} />
          <NumberField label="Y to" value={room.height[1]} onChange={(value) => edit({ height: [room.height[0], value === null ? null : tenth(value)] })} />
        </div>
        {hints}
        {room.rect ? <>
          <div className="floors-pair">
            <NumberField label="X" value={room.rect.x} onChange={(value) => { if (value !== null) editRect({ x: value }); }} />
            <NumberField label="Z" value={room.rect.z} onChange={(value) => { if (value !== null) editRect({ z: value }); }} />
            <NumberField label="Width" value={room.rect.width} onChange={(value) => { if (value !== null && value > 0) editRect({ width: value }); }} />
            <NumberField label="Depth" value={room.rect.depth} onChange={(value) => { if (value !== null && value > 0) editRect({ depth: value }); }} />
            <NumberField label="Angle" value={room.rect.angle} onChange={(value) => { if (value !== null) editRect({ angle: value }); }} />
          </div>
          {room.rect.angle !== 0 && <p className="faint">Rotated: tarkov.dev bounds can't hold this as drawn.</p>}
        </> : <p className="faint">Outline · {roomRings(room).flat().length} points: {roomRings(room).flat().length > MAX_HANDLES ? "too many to drag one by one;" : "drag them to reshape, or"} drag the outline to move it.{" "}
          <button type="button" className="link" onClick={() => edit({ rect: roomBox(room), area: undefined })}>Make a box</button></p>}
        <div className="floors-actions">
          <button type="button" className="secondary" onClick={() => setSelection(null)}>Done</button>
          <button type="button" className="secondary" title="Same shape on the floor above, starting at this room's Y to (Ctrl+D)" onClick={() => duplicate(room)}>Duplicate</button>
          <button type="button" className="secondary danger" onClick={() => { floorData.removeRoom(room.id); setSelection(null); }}>
            {room.source ? "Delete copy" : "Delete"}</button>
        </div>
      </div> : <ul className="floors-list">
        {rooms.map((other) => <li key={other.id}><button type="button" style={{ "--floor": colour(other.floor) } as CSSProperties}
          onClick={() => {
            setSelection({ kind: "drawn", id: other.id });
            setShown(other.floor);
            const box = roomBox(other);
            setCentre({ key: `${other.id}|${Date.now()}`, point: { key: other.id, x: box.x, z: box.z } });
          }}>
          <i /><span>{other.zone || "Unnamed"}{other.source ? " · copy" : ""}</span><span className="faint">{floorName(other.floor)} · {heightText(other.height)}</span>
        </button></li>)}
        {!rooms.length && <li className="faint">None yet. Draw one, or tap a floor data room on the map and edit it as a copy.</li>}
      </ul>}
    </aside>
  </div></MapAssetsContext.Provider>;
}

const heightText = ([low, high]: [number | null, number | null]) => levelText([low ?? -10000, high ?? 10000]);

/** A number typed freely and saved on Enter or leaving the field; empty saves null. */
function NumberField({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  const shownValue = value === null ? "" : String(+value.toFixed(2));
  const [text, setText] = useState(shownValue);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(shownValue); }, [shownValue, focused]);
  const commit = () => {
    const parsed = text.trim() === "" ? null : Number(text);
    if (parsed === null || Number.isFinite(parsed)) onChange(parsed);
    else setText(shownValue);
  };
  return <label>{label}<input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)}
    onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); commit(); }}
    onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} /></label>;
}
