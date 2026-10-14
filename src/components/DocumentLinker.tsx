import { useEffect, useState } from "react";
import { documentPhoto, type DocumentLocation, type MapLabel, type MapMarker, type WorldPoint } from "../maps";
import { ChevronLeftIcon, ChevronRightIcon } from "./Icons";

// Dev builds only: ties Battle Pass document reference photos to map spawns. Links go through the dev server into
// src/maps/documents/links.json (see scripts/document-links-plugin.mjs); re-running scripts/vendor-documents.mjs uses them as anchors.

/** Sets a location's link: a point, null for "no spawn is this one", undefined to drop the hand-made link. */
export async function saveDocumentLink(id: string, position: WorldPoint | null | undefined) {
  const response = await fetch("/__dev/document-links", { method: "POST", body: JSON.stringify({ id, position }) });
  if (!response.ok) throw new Error(await response.text());
}

/** Sets the floor (id, as in floors.ts) of a location linked by hand; null goes back to the floor at its position. */
export async function saveDocumentFloor(id: string, floor: string | null) {
  const response = await fetch("/__dev/document-links", { method: "POST", body: JSON.stringify({ id, floor }) });
  if (!response.ok) throw new Error(await response.text());
}

/** Sets whether a location is behind a lock; null goes back to whether tarkovdoc names a key. */
export async function saveDocumentLocked(id: string, locked: boolean | null) {
  const response = await fetch("/__dev/document-locked", { method: "POST", body: JSON.stringify({ id, locked }) });
  if (!response.ok) throw new Error(await response.text());
}

const metres = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const words = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()} `;
/** Labels named in a location's title, more than this far from its spot, make a match worth a look first. */
const LABEL_FAR_M = 80;

/** Why an automatic match looks off: its title names a labelled place that is far from where it was matched. */
function suspicion(location: DocumentLocation, labels: MapLabel[]): string | null {
  if (!location.position) return null;
  const title = words(location.title);
  const named = labels.filter((label) => words(label.text).length > 5 && title.includes(words(label.text)));
  if (!named.length) return null;
  const near = Math.min(...named.map((label) => metres({ x: label.position[0], z: label.position[1] }, location.position!)));
  return near > LABEL_FAR_M ? `${Math.round(near)} m from the "${named[0].text}" label` : null;
}

/** A request to show one location in the picker, on its tab. `nonce` makes a repeat click count. */
export type DocumentFocus = { id: string; nonce: number };

/** In a pinned document marker's card: how its photo got there, undoing it, and opening it in the picker. */
export function DocumentLinkActions({ marker, onOpen }: { marker: MapMarker; onOpen: (id: string) => void }) {
  const current = marker.document;
  return <div className="doc-link-actions">
    {current && <button type="button" className="secondary" onClick={() => onOpen(current.id)}>Open in doc viewer</button>}
    <span className="marker-card-sub">{!current ? "No photo linked" : current.match === "manual" ? "Linked by hand" : "Matched automatically"}</span>
    {current && <span className="marker-card-id">{current.id}</span>}
    {current && <button type="button" className="link" onClick={() => saveDocumentLink(current.id, null)}>Not this one</button>}
    {current?.match === "manual" && <button type="button" className="link" onClick={() => saveDocumentLink(current.id, undefined)}>Reset</button>}
  </div>;
}

type Mode = "unlinked" | "review" | "linked" | "placed";

/** Whether a location is behind a lock, with where that came from. */
function LockedField({ location }: { location: DocumentLocation }) {
  return <div className="doc-link-actions">
    <label className="doc-picker-check"><input type="checkbox" checked={location.locked} onChange={(event) => saveDocumentLocked(location.id, event.target.checked)} />Locked</label>
    <span className="marker-card-sub">{location.lockedByHand ? "set by hand" : location.key ? `tarkovdoc: ${location.key}` : "tarkovdoc names no key"}</span>
    {location.lockedByHand && <button type="button" className="link" onClick={() => saveDocumentLocked(location.id, null)}>Reset</button>}
  </div>;
}

/** The floor a location linked by hand is on: set by hand, or found from its position. */
function FloorField({ location, floors }: { location: DocumentLocation; floors: { id: string; name: string }[] }) {
  return <label className="doc-link-actions"><span className="marker-card-sub">Floor</span>
    <select value={location.floor ?? ""} onChange={(event) => saveDocumentFloor(location.id, event.target.value || null)}>
      <option value="">{location.position?.y === undefined ? "Auto (no height: base floor)" : "Auto (from height)"}</option>
      {floors.map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}
    </select>
  </label>;
}

/**
 * One photo at a time at the right of the map, in a fixed order that pinning doesn't change.
 * Unlinked: this map's locations with no spot; with a marker of its type pinned the shown one links to it, otherwise it is
 * placed by tapping the map. Review: automatic matches, suspicious ones first, to confirm (becomes a hand link) or reject.
 * Linked: hand links to spawns, to undo; Placed: locations placed on the map by hand, to undo. Both jump to the pinned
 * marker's, and set the floor. Any location can be marked as locked.
 */
export function DocumentPicker({ locations, labels, floors, placed, marker, focus, placing, onPlacing, onShow }: {
  locations: DocumentLocation[]; labels: MapLabel[]; /** The map's floors, to pick one for a hand link. */ floors: { id: string; name: string }[];
  /** Ids of the locations placed by hand where no spawn is. */ placed: Set<string>; marker: MapMarker | null; placing: string | null;
  /** Shows a location on whichever tab holds it. */ focus?: DocumentFocus | null;
  onPlacing: (id: string | null) => void; /** Pans to and pins the marker a location is matched to. */ onShow: (location: DocumentLocation) => void;
}) {
  const [mode, setMode] = useState<Mode>("unlinked");
  const unlinked = locations.filter((location) => !location.position);
  const auto = locations.filter((location) => location.match === "auto")
    .map((location) => ({ location, why: suspicion(location, labels) }))
    .sort((a, b) => +!!b.why - +!!a.why);
  const linked = locations.filter((location) => location.match === "manual" && !placed.has(location.id));
  const onMap = locations.filter((location) => placed.has(location.id));
  const list = mode === "linked" ? linked : mode === "placed" ? onMap : null;
  const count = mode === "unlinked" ? unlinked.length : mode === "review" ? auto.length : list!.length;
  const [index, setIndex] = useState(0);
  const pickMode = (next: Mode) => { setMode(next); setIndex(0); };
  useEffect(() => {
    if (!focus) return;
    const tabs: [Mode, DocumentLocation[]][] = [["unlinked", unlinked], ["review", auto.map(({ location }) => location)], ["linked", linked], ["placed", onMap]];
    for (const [tab, held] of tabs) {
      const at = held.findIndex((location) => location.id === focus.id);
      if (at >= 0) { setMode(tab); setIndex(at); onPlacing(null); return; }
    }
  }, [focus?.nonce]);
  // In Linked and Placed, pinning a marker shows its location.
  const pinnedAt = list && marker?.document ? list.findIndex((location) => location.id === marker.document!.id) : -1;
  useEffect(() => { if (pinnedAt >= 0) setIndex(pinnedAt); }, [marker?.id, mode]);
  // Settling one drops it from the list, leaving the next one in its place.
  const shown = Math.min(index, Math.max(0, count - 1));
  const location = mode === "unlinked" ? unlinked[shown] : mode === "review" ? auto[shown]?.location : list![shown];
  const why = mode === "review" ? auto[shown]?.why : null;
  const step = (by: number) => { if (count) setIndex((shown + by + count) % count); onPlacing(null); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const photo = location && documentPhoto(location);
  const fits = !!marker && !!location && marker.groups.includes(location.type);
  return <div className="doc-picker">
    <div className="doc-picker-head">
      <div className="doc-picker-modes" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "unlinked"} className={mode === "unlinked" ? "active" : ""} onClick={() => pickMode("unlinked")}>Unlinked {unlinked.length}</button>
        <button type="button" role="tab" aria-selected={mode === "review"} className={mode === "review" ? "active" : ""} onClick={() => pickMode("review")}>Review auto {auto.length}</button>
        <button type="button" role="tab" aria-selected={mode === "linked"} className={mode === "linked" ? "active" : ""} onClick={() => pickMode("linked")}>Linked {linked.length}</button>
        <button type="button" role="tab" aria-selected={mode === "placed"} className={mode === "placed" ? "active" : ""} onClick={() => pickMode("placed")}>Placed {onMap.length}</button>
      </div>
      <span className="marker-card-sub">{locations.length - unlinked.length}/{locations.length} linked</span>
    </div>
    {location ? <>
      <div className="doc-picker-photo">
        {photo ? <img src={photo} alt={location.title} draggable={false} /> : <span className="marker-card-sub">No photo</span>}
        <button type="button" className="icon-button prev" title="Previous (←)" onClick={() => step(-1)}><ChevronLeftIcon /></button>
        <button type="button" className="icon-button next" title="Next (→)" onClick={() => step(1)}><ChevronRightIcon /></button>
      </div>
      <div className="doc-picker-info">
        <span>{location.title}</span>
        {location.description && <span className="marker-card-sub">{location.description}</span>}
        <span className="marker-card-id">{location.id}</span>
        <span className="marker-card-sub">{[`${shown + 1} of ${count}`, location.type,
          mode === "unlinked" && fits && location.estimate ? `about ${Math.round(metres(location.estimate, marker.position))} m from the selected marker (est.)` : null]
          .filter(Boolean).join(" · ")}</span>
        {list && pinnedAt === shown && <span className="doc-picker-why">The pinned marker's document</span>}
        {why && <span className="doc-picker-why">Check this one: {why}</span>}
      </div>
      <LockedField location={location} />
      {list && floors.length > 1 && <FloorField location={location} floors={floors} />}
      {list
        ? <div className="doc-picker-actions">
          <button type="button" className="secondary" onClick={() => onShow(location)}>Show on map</button>
          <button type="button" className="secondary" onClick={() => saveDocumentLink(location.id, undefined)}>Unlink</button>
        </div>
        : mode === "review"
        ? <div className="doc-picker-actions">
          <button type="button" className="secondary" onClick={() => onShow(location)}>Show on map</button>
          <button type="button" className="secondary" onClick={() => saveDocumentLink(location.id, location.position!)}>Correct</button>
          <button type="button" className="secondary" onClick={() => saveDocumentLink(location.id, null)}>Wrong</button>
        </div>
        : marker
          ? <button type="button" className="secondary" disabled={!fits} onClick={() => saveDocumentLink(location.id, marker.position)}>
            {fits ? "Link to selected marker" : "Selected marker is another document type"}</button>
          : placing === location.id
            ? <div className="doc-link-actions"><span className="marker-card-sub">Tap the map where it is (floors stacked)</span>
              <button type="button" className="link" onClick={() => onPlacing(null)}>Cancel</button></div>
            : <button type="button" className="secondary" onClick={() => onPlacing(location.id)}>Place on map</button>}
    </> : <span className="marker-card-sub">{mode === "linked" ? "Nothing linked by hand here yet." : mode === "placed" ? "Nothing placed by hand here yet." : mode === "review" ? "No automatic matches left to review here."
      : "Every document here is linked. \"Not this one\" on a marker's card puts its photo back here."}</span>}
  </div>;
}
