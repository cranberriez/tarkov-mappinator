// Map overlay markers from tarkov.dev data, and the tiered filter over them:
// a layer (Extracts, Spawns) switches as a whole; its groups (PMC, Scav, …) switch inside it.
// A marker belongs to one layer and one or more groups, and shows when its layer and any of its groups are on.
import type { GameMapData, Vec3 } from "../tarkov-data/types.ts";

export type LayerDef = { key: string; label: string; icon: string; groups: { key: string; label: string; icon: string }[] };

export const layers: LayerDef[] = [
  { key: "extracts", label: "Extracts", icon: "extract_pmc", groups: [
    { key: "pmc", label: "PMC", icon: "extract_pmc" },
    { key: "scav", label: "Scav", icon: "extract_scav" },
    { key: "transit", label: "Transit", icon: "extract_transit" },
  ] },
  { key: "spawns", label: "Spawns", icon: "spawn_pmc", groups: [
    { key: "pmc", label: "PMC", icon: "spawn_pmc" },
    { key: "scav", label: "Scav", icon: "spawn_scav" },
  ] },
];

export type MapMarker = {
  id: string;
  layer: string;
  groups: string[];
  position: Vec3;
  /** Name drawn beside the icon when zoomed in. */
  label?: string;
  /** Extra detail for the tooltip, e.g. "Flare", "Paid". */
  tags: string[];
};

export type LayerFilter = { on: boolean; groups: Record<string, boolean> };
export type Filters = Record<string, LayerFilter>;
export type Role = "pmc" | "scav" | "unknown";

/** `RaidState.player_role` → role; anything unrecognised (including null) is unknown. */
export function roleOf(playerRole: string | null | undefined): Role {
  const value = (playerRole ?? "").toLowerCase();
  return value.includes("scav") || value === "savage" ? "scav" : value.includes("pmc") || value === "usec" || value === "bear" ? "pmc" : "unknown";
}

/** Everything on; a known role turns the other faction's groups off. Transits are PMC-only in game. */
export function defaultFilters(role: Role): Filters {
  const off = new Set(role === "pmc" ? ["scav"] : role === "scav" ? ["pmc", "transit"] : []);
  return Object.fromEntries(layers.map((layer) => [layer.key, {
    on: true,
    groups: Object.fromEntries(layer.groups.map((group) => [group.key, !off.has(group.key)])),
  }]));
}

/** Stored filters over the defaults, so layers and groups added later start in their default state. */
export function withDefaults(stored: Partial<Filters> | undefined, role: Role): Filters {
  const defaults = defaultFilters(role);
  return Object.fromEntries(Object.entries(defaults).map(([key, layer]) => [key, {
    on: stored?.[key]?.on ?? layer.on,
    groups: { ...layer.groups, ...stored?.[key]?.groups },
  }]));
}

export const isVisible = (marker: MapMarker, filters: Filters) => {
  const layer = filters[marker.layer];
  return !!layer?.on && marker.groups.some((group) => layer.groups[group]);
};

const ROUBLES = "5449016a4bdc2d6f028b456f";
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

function extractTags(name: string, transferItem: { item: string } | undefined) {
  const tags: string[] = [];
  if (/\(flare\)/i.test(name)) tags.push("Flare");
  if (/co-op/i.test(name)) tags.push("Co-op");
  if (transferItem) tags.push(transferItem.item === ROUBLES ? "Paid" : "Item required");
  return tags;
}

/** All overlay markers for a map, unfiltered. */
export function buildMarkers(data: GameMapData): MapMarker[] {
  const markers: MapMarker[] = [];

  // Extracts without a faction (Night Factory, Ground Zero 21+) count as shared.
  // A PMC and a Scav extract with the same name at the same spot become one marker for both.
  const extracts: MapMarker[] = [];
  for (const extract of data.extracts ?? []) {
    const groups = extract.faction === "pmc" ? ["pmc"] : extract.faction === "scav" ? ["scav"] : ["pmc", "scav"];
    const twin = extracts.find((other) => other.label === extract.name && distance(other.position, extract.position) < 10);
    if (twin) {
      twin.groups = [...new Set([...twin.groups, ...groups])];
      continue;
    }
    const transferItem = (extract as { transferItem?: { item: string } }).transferItem;
    extracts.push({ id: `extract:${extract.id}`, layer: "extracts", groups, position: extract.position,
      label: extract.name, tags: extractTags(extract.name, transferItem) });
  }
  markers.push(...extracts);

  for (const transit of data.transits ?? []) {
    markers.push({ id: `transit:${transit.id}`, layer: "extracts", groups: ["transit"], position: transit.position,
      label: transit.description.replace(/^Transit to /i, "→ "), tags: [] });
  }

  // Player spawns only; bot-only spawn points are a separate concern.
  const seen = new Set<string>();
  for (const spawn of data.spawns ?? []) {
    if (!spawn.categories.includes("player")) continue;
    const sides = spawn.sides.includes("all") ? ["pmc", "scav"] : spawn.sides.filter((side) => side === "pmc" || side === "scav");
    if (!sides.length) continue;
    const { x, y, z } = spawn.position;
    const key = `${sides}|${x.toFixed(1)}|${z.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({ id: `spawn:${key}`, layer: "spawns", groups: sides, position: { x, y, z },
      tags: spawn.categories.includes("sniper") ? ["Sniper"] : [] });
  }
  return markers;
}

/** Icon file stem for a marker, given which of its groups are currently shown. */
export function markerIcon(marker: MapMarker, filters: Filters): string {
  const shown = marker.groups.filter((group) => filters[marker.layer]?.groups[group]);
  if (marker.layer === "spawns") return shown.includes("pmc") ? "spawn_pmc" : "spawn_scav";
  if (shown.includes("transit")) return "extract_transit";
  return shown.includes("pmc") && shown.includes("scav") ? "extract_shared" : shown.includes("scav") ? "extract_scav" : "extract_pmc";
}

/** Marker count per layer and per layer group, for the filter panel. */
export function countMarkers(markers: MapMarker[]) {
  const counts: Record<string, number> = {};
  for (const marker of markers) {
    counts[marker.layer] = (counts[marker.layer] ?? 0) + 1;
    for (const group of marker.groups) counts[`${marker.layer}.${group}`] = (counts[`${marker.layer}.${group}`] ?? 0) + 1;
  }
  return counts;
}

/** Whether two filter states show the same markers' switches, ignoring key order. */
export function sameFilters(a: Filters, b: Filters): boolean {
  return layers.every((layer) => a[layer.key]?.on === b[layer.key]?.on
    && layer.groups.every((group) => a[layer.key]?.groups[group.key] === b[layer.key]?.groups[group.key]));
}
