import { useState } from "react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { Scanner } from "../lib/useScanner";
import { clock } from "../lib/format";
import { extentsAt, floorAt, floorLevels, levelText, type ExtentHit } from "../maps/floors";
import { mapName, resolveMap } from "../maps";
import type { FloorExtent } from "../maps";
import { ChevronLeftIcon, ChevronRightIcon, MissingImageIcon } from "../components/Icons";

const fixed = (value: number) => value.toFixed(2);

/** A full-size screenshot URL; captures live in the screenshots folder under their filename. */
const shotSrc = (folder: string, filename: string) =>
  isTauri() && folder ? convertFileSrc(`${folder.replace(/[\\/]+$/, "")}\\${filename}`) : undefined;

/** What names an extent: its label, else the labels of its room boxes. */
const extentName = (extent: FloorExtent) =>
  extent.label ?? ([...new Set(extent.bounds?.map((bounds) => bounds[2]).filter((label): label is string => typeof label === "string"))].join(", ") || null);

/** Dev: each capture as it arrives, with its position and the map, floor and floor zone it resolves to. */
export function ShotsPage({ scanner }: { scanner: Scanner }) {
  const shots = [...scanner.positions].reverse();
  // Null follows the newest capture.
  const [picked, setPicked] = useState<string | null>(null);
  const index = Math.max(0, picked ? shots.findIndex((shot) => shot.filename === picked) : 0);
  const shot = shots[index];
  const go = (to: number) => setPicked(to <= 0 ? null : shots[Math.min(to, shots.length - 1)].filename);

  return <div className="shots-page">
    <header className="shots-header">
      <h1>Shots</h1>
      <span className="faint">{shots.length ? `${index + 1} / ${shots.length}` : ""}{picked === null && shots.length ? " · following newest" : ""}</span>
      <div className="shots-nav">
        <button type="button" className="icon-button" title="Newer" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeftIcon /></button>
        <button type="button" className="icon-button" title="Older" disabled={index >= shots.length - 1} onClick={() => go(index + 1)}><ChevronRightIcon /></button>
        <button type="button" disabled={picked === null} onClick={() => setPicked(null)}>Newest</button>
      </div>
    </header>
    {shot ? <Shot key={shot.filename} shot={shot} scanner={scanner} /> : <p className="faint">No screenshots yet. Start monitoring and take one in raid.</p>}
  </div>;
}

function Shot({ shot, scanner }: { shot: Scanner["positions"][number]; scanner: Scanner }) {
  const [missing, setMissing] = useState(false);
  const src = shotSrc(scanner.snapshot?.config.screenshots ?? "", shot.filename);
  const raid = scanner.raids.find((record) => record.id === shot.raid_id) ?? null;
  const rawMap = raid?.map ?? (scanner.snapshot?.raid.id === shot.raid_id ? scanner.snapshot?.raid.map : null) ?? null;
  const map = resolveMap(rawMap);
  const [x, y, z] = shot.xyz;
  const point = { x, y, z };
  const floor = map ? floorAt(map, point) : null;
  const range = map && floor ? floorLevels(map, floor) : null;
  const hits = map ? extentsAt(map, point) : [];
  const zone = hits.filter((hit) => hit.inHeight && hit.floor === floor?.id).map((hit) => extentName(hit.extent) ?? hit.floor).at(-1) ?? null;

  const rows: [string, string][] = [
    ["X", fixed(x)], ["Y", fixed(y)], ["Z", fixed(z)],
    ["Heading", shot.heading_degrees === null ? "—" : `${shot.heading_degrees.toFixed(1)}°`],
    ["Map", rawMap ? `${mapName(rawMap) ?? rawMap}${map ? "" : " (no art)"}` : "—"],
    ["Floor", floor ? `${floor.name}${range ? ` · ${levelText(range)}` : ""}` : "—"],
    ["Zone", zone ?? "—"],
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
      {hits.length > 0 && <>
        <h2>Floor extents here</h2>
        <ul className="shots-extents">{hits.map((hit, at) => <Extent key={at} hit={hit} y={y} />)}</ul>
      </>}
    </div>
  </div>;
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
