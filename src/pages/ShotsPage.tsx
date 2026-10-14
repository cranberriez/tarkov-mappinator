import { useEffect, useState } from "react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { Scanner } from "../lib/useScanner";
import type { PositionObservation } from "../bindings/PositionObservation";
import { clock } from "../lib/format";
import { extentName, guessAt, useFloorData, type FloorData } from "../lib/floorData";
import { extentsAt, floorAt, floorLevels, floorsOf, levelText, mapName, resolveGame, resolveMap, type ExtentHit, type MapCalibration } from "../maps";
import { ChevronLeftIcon, ChevronRightIcon, MissingImageIcon } from "../components/Icons";

const fixed = (value: number) => value.toFixed(2);

/** A full-size screenshot URL; captures live in the screenshots folder under their filename. */
const shotSrc = (folder: string, filename: string) =>
  isTauri() && folder ? convertFileSrc(`${folder.replace(/[\\/]+$/, "")}\\${filename}`) : undefined;

/** The raw map a capture was taken on: its raid's, or the live raid's while that has no record yet. */
export function shotMap(scanner: Scanner, shot: PositionObservation): string | null {
  const raid = scanner.raids.find((record) => record.id === shot.raid_id);
  return raid?.map ?? (scanner.snapshot?.raid.id === shot.raid_id ? scanner.snapshot?.raid.map : null) ?? null;
}

/** Dev: each capture as it arrives, with its position, what the floor data makes of it, and the floor it is labelled with. */
export function ShotsPage({ scanner, initial = null }: { scanner: Scanner; initial?: string | null }) {
  const shots = [...scanner.positions].reverse();
  // Null follows the newest capture.
  const [picked, setPicked] = useState<string | null>(initial);
  const index = Math.max(0, picked ? shots.findIndex((shot) => shot.filename === picked) : 0);
  const shot = shots[index];
  const go = (to: number) => { if (to >= 0 && to < shots.length) setPicked(to === 0 ? null : shots[to].filename); };
  const rawMap = shot ? shotMap(scanner, shot) : null;
  const floorData = useFloorData(resolveGame(rawMap)?.key ?? null);

  return <div className="shots-page">
    <header className="shots-header">
      <h1>Shots</h1>
      <span className="faint">{shots.length ? `${index + 1} / ${shots.length}` : ""}{picked === null && shots.length ? " · following newest" : ""}</span>
      <div className="shots-nav">
        <button type="button" className="icon-button" title="Newer (←)" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeftIcon /></button>
        <button type="button" className="icon-button" title="Older (→)" disabled={index >= shots.length - 1} onClick={() => go(index + 1)}><ChevronRightIcon /></button>
        <button type="button" disabled={picked === null} onClick={() => setPicked(null)}>Newest</button>
      </div>
    </header>
    {shot ? <Shot key={shot.filename} shot={shot} rawMap={rawMap} folder={scanner.snapshot?.config.screenshots ?? ""} floorData={floorData}
      onNewer={() => go(index - 1)} onOlder={() => go(index + 1)} />
      : <p className="faint">No screenshots yet. Start monitoring and take one in raid.</p>}
  </div>;
}

function Shot({ shot, rawMap, folder, floorData, onNewer, onOlder }: {
  shot: PositionObservation; rawMap: string | null; folder: string; floorData: FloorData; onNewer: () => void; onOlder: () => void;
}) {
  const [missing, setMissing] = useState(false);
  const src = shotSrc(folder, shot.filename);
  const map = resolveMap(rawMap);
  const [x, y, z] = shot.xyz;
  const point = { x, y, z };
  const floor = map ? floorAt(map, point) : null;
  const range = map && floor ? floorLevels(map, floor) : null;
  const hits = map ? extentsAt(map, point) : [];
  const guess = map ? guessAt(map, floorData.data?.rooms ?? [], point) : null;

  const rows: [string, string][] = [
    ["X", fixed(x)], ["Y", fixed(y)], ["Z", fixed(z)],
    ["Heading", shot.heading_degrees === null ? "—" : `${shot.heading_degrees.toFixed(1)}°`],
    ["Map", rawMap ? `${mapName(rawMap) ?? rawMap}${map ? "" : " (no art)"}` : "—"],
    ["Floor", floor ? `${floor.name}${range ? ` · ${levelText(range)}` : ""}` : "—"],
    ["Zone", guess?.zone ?? "—"],
    ["Captured", clock(shot.captured_at)], ["Observed", clock(shot.observed_at)],
    ["Raid", shot.raid_id ?? "—"], ["File", shot.filename],
  ];

  return <div className="shots-body">
    <div className="shots-image">
      {src && !missing
        ? <img src={src} alt={shot.filename} draggable={false} onError={() => setMissing(true)} />
        : <div className="shots-missing"><MissingImageIcon /><span>{src ? "Screenshot deleted" : "No screenshots folder"}</span></div>}
    </div>
    <div className="shots-data">
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {map && guess && floorData.data
        ? <Label shot={shot} map={map} guess={guess} floorData={floorData} onNewer={onNewer} onOlder={onOlder} />
        : <Keys onNewer={onNewer} onOlder={onOlder} />}
      {floorData.error && <p className="shots-error">{floorData.error}</p>}
      {hits.length > 0 && <>
        <h2>Floor extents here</h2>
        <ul className="shots-extents">{hits.map((hit, at) => <Extent key={at} hit={hit} y={y} />)}</ul>
      </>}
    </div>
  </div>;
}

const typing = (target: EventTarget | null) => target instanceof HTMLElement && target.matches("input, select, textarea");

/** Arrow keys step through captures (Left: newer, Right: older), outside text fields. */
function useArrowKeys(onNewer: () => void, onOlder: () => void, more?: (event: KeyboardEvent) => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!typing(event.target) && event.key === "ArrowLeft") { event.preventDefault(); onNewer(); }
      else if (!typing(event.target) && event.key === "ArrowRight") { event.preventDefault(); onOlder(); }
      else more?.(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}

function Keys({ onNewer, onOlder }: { onNewer: () => void; onOlder: () => void }) {
  useArrowKeys(onNewer, onOlder);
  return null;
}

/**
 * The floor a capture was really taken on, saved to the map's floor dataset. The app's guess is marked; Enter confirms the
 * label shown (the guess until labelled), 1–9 pick a floor, Delete drops the label.
 */
function Label({ shot, map, guess, floorData, onNewer, onOlder }: {
  shot: PositionObservation; map: MapCalibration; guess: { floor: string; zone?: string }; floorData: FloorData; onNewer: () => void; onOlder: () => void;
}) {
  const data = floorData.data!;
  const sample = data.samples.find((other) => other.id === shot.filename);
  const floors = floorsOf(map);
  const [zone, setZone] = useState(sample?.zone ?? guess.zone ?? "");
  const zones = [...new Set([...data.rooms.map((room) => room.zone), ...data.samples.map((other) => other.zone)].filter((name): name is string => !!name))].sort();
  const [x, y, z] = shot.xyz;
  const save = (floor: string) => floorData.setSample({
    id: shot.filename, x, y, z, floor, ...zone.trim() ? { zone: zone.trim() } : {}, guess, at: new Date().toISOString(),
  });

  useArrowKeys(onNewer, onOlder, (event) => {
    if (event.key === "Enter" && (!typing(event.target) || (event.target as HTMLElement).matches("input.shots-zone"))) {
      event.preventDefault();
      save(sample?.floor ?? guess.floor);
    } else if (typing(event.target)) return;
    else if (/^[1-9]$/.test(event.key) && floors[+event.key - 1]) save(floors[+event.key - 1].id);
    else if (event.key === "Delete" && sample) floorData.removeSample(shot.filename);
  });

  const name = (id: string) => floors.find((other) => other.id === id)?.name ?? id;
  return <section className="shots-label">
    <h2>Actual floor</h2>
    <div className="shots-floors">{floors.map((option, at) => <button key={option.id} type="button"
      className={`${sample?.floor === option.id ? "chosen" : ""} ${guess.floor === option.id ? "guess" : ""}`}
      title={guess.floor === option.id ? "The app's guess" : undefined} onClick={() => save(option.id)}>
      {at < 9 && <kbd>{at + 1}</kbd>}{option.name}
    </button>)}</div>
    <input className="shots-zone" list="shots-zones" placeholder="Zone (building or room)" value={zone} onChange={(event) => setZone(event.target.value)} />
    <datalist id="shots-zones">{zones.map((option) => <option key={option} value={option} />)}</datalist>
    <p className="faint">
      {sample ? <>Labelled {name(sample.floor)}{sample.zone ? ` · ${sample.zone}` : ""}{sample.guess.floor !== sample.floor ? ` · guess was ${name(sample.guess.floor)}` : " · guess was right"}
        {" "}<button type="button" className="link" onClick={() => floorData.removeSample(shot.filename)}>Remove</button></>
        : <>Not labelled · Enter confirms {name(guess.floor)}</>}
    </p>
  </section>;
}

/** An extent over this spot: whether the height falls in it, and by how much it misses or clears its bounds. */
function Extent({ hit, y }: { hit: ExtentHit; y: number }) {
  const [low, high] = hit.extent.height;
  const delta = y < low ? `${fixed(low - y)} below` : y >= high ? `${fixed(y - high)} above` : `+${fixed(y - low)} over floor`;
  return <li className={hit.inHeight ? "in" : ""}>
    <span>{hit.floor}{extentName(hit.extent) ? ` · ${extentName(hit.extent)}` : ""}{hit.inside ? "" : " (edge)"}</span>
    <span className="faint">{levelText(hit.extent.height)} · {Math.abs(low) >= 1000 && y >= low && y < high ? "in" : delta}</span>
  </li>;
}
