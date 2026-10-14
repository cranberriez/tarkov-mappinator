// Battle Pass document locations with a reference photo each, vendored by `node scripts/vendor-documents.mjs`
// from the Tarkov Hideout repo's tarkovdoc.com snapshot. A location ties to a tarkov.dev document spawn by
// position: the script snaps confident matches to the spawn, and `documents/links.json` holds hand-made links
// (a null link means the location is no spawn), which win over the script's. A link can also give the `floor` (id, as in
// floors.ts) the location is on, for a spot its height puts on the wrong one. Season-specific, like the preset.
import data from "./documents/locations.json";
import links from "./documents/links.json";
import type { WorldPoint } from "./types.ts";

const photos = import.meta.glob<string>("./assets/documents/*.webp", { eager: true, query: "?url", import: "default" });

export type DocumentLocation = {
  /** `<tarkovdoc map>/<tarkovdoc id>`. */
  id: string;
  /** tarkov.dev map keys it is on. */
  maps: string[];
  /** Document type key, as in the preset's `documents`. */
  type: string;
  title: string;
  description?: string;
  /** Key needed to reach it. */
  key?: string;
  /** Photo file in `assets/documents`. */
  photo?: string;
  /** Where it is, when tied to a spawn (or placed by hand where tarkov.dev has none). */
  position?: WorldPoint;
  match?: "auto" | "manual";
  /** Floor id it is on, set by hand where its height misleads; otherwise its floor is found from its position. */
  floor?: string;
  /** Where the fit puts it, when not tied to a spawn; rough. */
  estimate?: WorldPoint;
};

export const documentSource = data.source;
const all = data.locations as DocumentLocation[];
const manual = links as Record<string, (WorldPoint & { floor?: string }) | null>;

/** Locations on a map, with hand-made links applied. */
export function documentLocations(mapKey: string): DocumentLocation[] {
  return all.filter((location) => location.maps.includes(mapKey)).map((location) => {
    // A hand link removed since the script last ran leaves the location unlinked, not at the old spot.
    if (!(location.id in manual) && location.match !== "manual") return location;
    const link = manual[location.id];
    const { position: _, match: __, ...rest } = location;
    if (!link) return rest;
    const { floor, ...position } = link;
    return { ...rest, position, match: "manual", ...floor ? { floor } : {} };
  });
}

export const documentPhoto = (location: Pick<DocumentLocation, "photo">): string | undefined =>
  location.photo ? photos[`./assets/documents/${location.photo}`] : undefined;
