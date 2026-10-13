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

/** In a pinned document marker's card: how its photo got there, and undoing it. */
export function DocumentLinkActions({ marker }: { marker: MapMarker }) {
  const current = marker.document;
  return <div className="doc-link-actions">
    <span className="marker-card-sub">{!current ? "No photo linked" : current.match === "manual" ? "Linked by hand" : "Matched automatically"}</span>
    {current && <span className="marker-card-id">{current.id}</span>}
    {current && <button type="button" className="link" onClick={() => saveDocumentLink(current.id, null)}>Not this one</button>}
    {current?.match === "manual" && <button type="button" className="link" onClick={() => saveDocumentLink(current.id, undefined)}>Reset</button>}
  </div>;
}

type Mode = "unlinked" | "review" | "linked";

/**
 * One photo at a time at the right of the map, in a fixed order that pinning doesn't change.
 * Unlinked: this map's locations with no spot; with a marker of its type pinned the shown one links to it, otherwise it is
 * placed by tapping the map. Review: automatic matches, suspicious ones first, to confirm (becomes a hand link) or reject.
 * Linked: hand links, to undo; it jumps to the pinned marker's.
 */
export function DocumentPicker({ locations, labels, marker, placing, onPlacing, onShow }: {
  locations: DocumentLocation[]; labels: MapLabel[]; marker: MapMarker | null; placing: string | null;
  onPlacing: (id: string | null) => void; /** Pans to and pins the marker a location is matched to. */ onShow: (location: DocumentLocation) => void;
}) {
  const [mode, setMode] = useState<Mode>("unlinked");
  const unlinked = locations.filter((location) => !location.position);
  const auto = locations.filter((location) => location.match === "auto")
    .map((location) => ({ location, why: suspicion(location, labels) }))
    .sort((a, b) => +!!b.why - +!!a.why);
  const linked = locations.filter((location) => location.match === "manual");
  const count = mode === "unlinked" ? unlinked.length : mode === "review" ? auto.length : linked.length;
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [mode]);
  // In Linked, pinning a marker shows its location.
  const pinnedAt = mode === "linked" && marker?.document ? linked.findIndex((location) => location.id === marker.document!.id) : -1;
  useEffect(() => { if (pinnedAt >= 0) setIndex(pinnedAt); }, [marker?.id, mode]);
  // Settling one drops it from the list, leaving the next one in its place.
  const shown = Math.min(index, Math.max(0, count - 1));
  const location = mode === "unlinked" ? unlinked[shown] : mode === "review" ? auto[shown]?.location : linked[shown];
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
        <button type="button" role="tab" aria-selected={mode === "unlinked"} className={mode === "unlinked" ? "active" : ""} onClick={() => setMode("unlinked")}>Unlinked {unlinked.length}</button>
        <button type="button" role="tab" aria-selected={mode === "review"} className={mode === "review" ? "active" : ""} onClick={() => setMode("review")}>Review auto {auto.length}</button>
        <button type="button" role="tab" aria-selected={mode === "linked"} className={mode === "linked" ? "active" : ""} onClick={() => setMode("linked")}>Linked {linked.length}</button>
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
        {mode === "linked" && pinnedAt === shown && <span className="doc-picker-why">The pinned marker's document</span>}
        {why && <span className="doc-picker-why">Check this one: {why}</span>}
      </div>
      {mode === "linked"
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
    </> : <span className="marker-card-sub">{mode === "linked" ? "Nothing linked by hand here yet." : mode === "review" ? "No automatic matches left to review here."
      : "Every document here is linked. \"Not this one\" on a marker's card puts its photo back here."}</span>}
  </div>;
}
