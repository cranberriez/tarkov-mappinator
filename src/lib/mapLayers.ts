// Map overlay markers from tarkov.dev data, and the tiered filter over them:
// a layer (Extracts, Spawns, …) holds groups (PMC, Scav, …) that switch on and off; the layer itself has no
// switch of its own, its header sets all its groups at once. A marker belongs to one layer and one or more
// groups, and shows when any of its groups is on.
import type { Extract, GameMapData, Mob, Vec3 } from "../tarkov-data/types.ts";

/** `icon` is a file stem in `src/maps/assets/icons`, or `item:<tarkov.dev item id>`. */
type GroupDef = { key: string; label: string; icon: string; /** Colour behind the icon. */ tint?: string; /** Hidden until switched on. */ off?: boolean;
  /** Portrait link shown instead of the icon (boss types). */ image?: string };
export type LayerDef = {
  key: string; label: string; icon: string; groups: GroupDef[];
  /** All groups hidden until switched on. */ off?: boolean;
  /** Folded in the panel until opened. */ folded?: boolean;
};

/** Battle Pass document items (tarkov.dev ids) by group; each map spawns two of these. */
const documentTypes = [
  { key: "financial", label: "Financial", item: "6a31807f17005505b70d5827", tint: "#7cc39a" },
  { key: "project", label: "Project", item: "6a3181f178450ec91c0ea1aa", tint: "#dbb36b" },
  { key: "blueprints", label: "Blueprints", item: "6a31824878450ec91c0ea1ae", tint: "#6fa8dc" },
  { key: "test", label: "Test", item: "6a31828557705071410ca00e", tint: "#a78bd6" },
  { key: "user", label: "User", item: "6a3182b72fd891345e047eef", tint: "#5fc4c0" },
  { key: "medical", label: "Medical", item: "6a3182dc6cd8de21cf0a3a7d", tint: "#e37b6c" },
  { key: "technical", label: "Technical", item: "6a31830dde69ceafd805afa0", tint: "#e8985a" },
  { key: "personnel", label: "PMC personnel", item: "6a317b9692cfdcddcb02a58e", tint: "#d98fb3" },
];
const documentGroup = new Map(documentTypes.map(({ key, item }) => [item, key]));

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
  // One group per boss type on the map, filled in by `layersFor`.
  { key: "bosses", label: "Bosses", icon: "spawn_boss", folded: true, groups: [] },
  { key: "hazards", label: "Hazards", icon: "hazard", folded: true, groups: [
    { key: "minefield", label: "Minefields", icon: "hazard" },
    { key: "sniper", label: "Sniper zones", icon: "hazard" },
    { key: "artillery", label: "Artillery", icon: "hazard_mortar" },
    { key: "other", label: "Other", icon: "hazard" },
  ] },
  { key: "containers", label: "Containers", icon: "container_safe", folded: true, groups: [
    { key: "valuables", label: "Valuables", icon: "container_safe" },
    { key: "medical", label: "Medical", icon: "container_medbag" },
    { key: "ammo", label: "Ammo & grenades", icon: "container_grenade-box" },
    { key: "caches", label: "Caches", icon: "container_buried-barrel-cache" },
    { key: "supply", label: "Supply crates", icon: "container_crate", off: true },
    { key: "bodies", label: "Bodies", icon: "container_dead-scav", off: true },
    { key: "general", label: "General", icon: "container_duffle-bag", off: true },
  ] },
  { key: "access", label: "Keys & switches", icon: "key", folded: true, groups: [
    { key: "door", label: "Locked doors", icon: "lock" },
    { key: "trunk", label: "Locked trunks", icon: "lock" },
    { key: "switch", label: "Switches", icon: "switch" },
  ] },
  { key: "other", label: "Weapons & BTR", icon: "stationarygun", folded: true, groups: [
    { key: "stationary", label: "Stationary guns", icon: "stationarygun" },
    { key: "btr", label: "BTR stops", icon: "btr_stop" },
  ] },
  { key: "documents", label: "Battle Pass documents", icon: "quest_item", groups: documentTypes.map(({ key, label, item, tint }) => ({ key, label, tint, icon: `item:${item}` })) },
  { key: "loose", label: "Loose loot", icon: "loose_loot", off: true, folded: true, groups: [
    { key: "loose", label: "Loose loot", icon: "loose_loot" },
  ] },
];

/** One row of a marker's detail card; `items` are item ids, `mono` marks a raw id with no name yet. */
export type Detail = { label: string; value?: string; items?: { id: string; count?: number }[]; mono?: boolean };

/** One boss type at a spawn point; several spawn entries of the same type are merged into one. */
export type BossInfo = {
  /** Filter group: the mob's normalized name, or "pmcs" for PMC bots. */ group: string;
  name: string; /** Map icon stem. */ icon: string; /** Portrait link. */ image?: string;
  /** Chance (0–1) that at least one of them spawns here. */ chance: number;
  /** Chance (0–1) of spawning in the raid at all; only for a single entry. */ raidChance?: number;
  /** Number of spawn entries merged in. */ entries: number;
  location: string; escorts: { name: string; count: string }[]; spawnTime?: string; trigger?: string;
};

export type MapMarker = {
  id: string;
  layer: string;
  groups: string[];
  position: Vec3;
  /** Fixed icon stem; extracts, spawns and bosses pick theirs from the shown groups instead. */
  icon?: string;
  /** Footprint for zones (hazards, artillery), drawn in world x/z. */
  outline?: Vec3[];
  /** Name; drawn beside extract icons when zoomed in, otherwise shown on hover. */
  label?: string;
  /** What it is and extra detail, shown on hover after the label, e.g. "Container", "Flare", "Paid". */
  tags: string[];
  /** Everything else known about it, shown on the detail card. */
  details?: Detail[];
  /** Boss spawn points: one entry per boss type, shown as stacked cards instead of `details`. */
  bosses?: BossInfo[];
};

export type LayerFilter = { groups: Record<string, boolean> };
export type Filters = Record<string, LayerFilter>;
export type Role = "pmc" | "scav" | "unknown";

/** `RaidState.player_role` → role; anything unrecognised (including null) is unknown. */
export function roleOf(playerRole: string | null | undefined): Role {
  const value = (playerRole ?? "").toLowerCase();
  return value.includes("scav") || value === "savage" ? "scav" : value.includes("pmc") || value === "usec" || value === "bear" ? "pmc" : "unknown";
}

/**
 * Each layer's own defaults; a known role also turns the other faction's extracts and spawns off.
 * Transits are PMC-only in game.
 */
export function defaultFilters(role: Role): Filters {
  const off = new Set(role === "pmc" ? ["scav"] : role === "scav" ? ["pmc", "transit"] : []);
  const factional = new Set(["extracts", "spawns"]);
  return Object.fromEntries(layers.map((layer) => [layer.key, {
    groups: Object.fromEntries(layer.groups.map((group) =>
      [group.key, !layer.off && !group.off && !(factional.has(layer.key) && off.has(group.key))])),
  }]));
}

/**
 * Stored filters over the defaults, so layers and groups added later start in their default state.
 * Older saves had a separate layer switch; a layer saved as off now means all its groups are off.
 */
export function withDefaults(stored: Partial<Record<string, LayerFilter & { on?: boolean }>> | undefined, role: Role): Filters {
  const defaults = defaultFilters(role);
  return Object.fromEntries(Object.entries(defaults).map(([key, layer]) => {
    const saved = stored?.[key];
    const groups = { ...layer.groups, ...saved?.groups };
    if (key === "bosses") for (const group of legacyBossGroups) delete groups[group];
    if (saved?.on === false) for (const group of Object.keys(groups)) groups[group] = false;
    return [key, { groups }];
  }));
}

/**
 * Boss types start on, except these (matched on the group key: normalized names, and raw mob ids when a
 * mob has no lookup). Boss groups come from the map's data, so defaults can't list them.
 */
const bossOff = new Set(["pmcs", "raider", "rogue", "black-div", "af", "pmcBot", "exUsec", "arenaFighter", "arenaFighterEvent"]);
/** Older saves held "Bosses" and "Raiders & Rogues" groups; they mean nothing now. */
const legacyBossGroups = ["bosses", "raiders"];

/** Whether a group is on; one the filter has no entry for (a boss type not seen before) takes its default. */
export const groupOn = (filter: LayerFilter | undefined, group: string) => filter?.groups[group] ?? !bossOff.has(group);

/** Header state of a layer over the given groups: all on, none on, or some. */
export function layerState(filter: LayerFilter, groups: string[]): "on" | "off" | "mixed" {
  const on = groups.filter((group) => groupOn(filter, group)).length;
  return on === 0 ? "off" : on === groups.length ? "on" : "mixed";
}

/** The header click: any of the groups on turns them all off, otherwise all on. Other groups are left alone. */
export function toggleLayer(filter: LayerFilter, groups: string[]): LayerFilter {
  const on = layerState(filter, groups) === "off";
  return { groups: { ...filter.groups, ...Object.fromEntries(groups.map((group) => [group, on])) } };
}

export const isVisible = (marker: MapMarker, filters: Filters) => {
  const layer = filters[marker.layer];
  return !!layer && marker.groups.some((group) => groupOn(layer, group));
};

const ROUBLES = "5449016a4bdc2d6f028b456f";
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const posKey = ({ x, y, z }: Vec3) => `${x.toFixed(1)}|${y.toFixed(1)}|${z.toFixed(1)}`;
const percent = (chance: number) => `${Math.round(chance * 100)}%`;
const metres = (value: number) => `${+value.toFixed(1)}`;
/** "bottom–top m" for a height band, when the data has one. */
const heightDetail = (top: number | undefined, bottom: number | undefined): Detail[] =>
  typeof top === "number" && typeof bottom === "number" ? [{ label: "Height", value: `${metres(bottom)}–${metres(top)} m` }] : [];
const compact = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

function extractTags(name: string, transferItem: { item: string } | undefined) {
  const tags: string[] = [];
  if (/\(flare\)/i.test(name)) tags.push("Flare");
  if (/co-op/i.test(name)) tags.push("Co-op");
  if (transferItem) tags.push(transferItem.item === ROUBLES ? "Paid" : "Item required");
  return tags;
}

type Named = { name: string; normalizedName: string };
/** Name tables the map documents point into: `common.json` containers and guns, `mobs.json` mobs. */
export type Lookups = { containers?: Record<string, Named>; weapons?: Record<string, Named>; mobs?: Record<string, Named & Partial<Mob>>; /** Map id → name. */ maps?: Record<string, string> };

/** All overlay markers for a map, unfiltered. */
export function buildMarkers(data: GameMapData, lookups: Lookups = {}): MapMarker[] {
  return [
    ...extractMarkers(data, lookups), ...spawnMarkers(data), ...bossMarkers(data, lookups),
    ...zoneMarkers(data), ...pointMarkers(data, lookups),
  ];
}

function extractMarkers(data: GameMapData, lookups: Lookups): MapMarker[] {
  // Extracts without a faction (Night Factory, Ground Zero 21+) count as shared.
  // A PMC and a Scav extract with the same name at the same spot become one marker for both.
  const extracts: MapMarker[] = [];
  const sources = new Map<MapMarker, Extract>();
  for (const extract of data.extracts ?? []) {
    const groups = extract.faction === "pmc" ? ["pmc"] : extract.faction === "scav" ? ["scav"] : ["pmc", "scav"];
    const twin = extracts.find((other) => other.label === extract.name && distance(other.position, extract.position) < 10);
    if (twin) {
      twin.groups = [...new Set([...twin.groups, ...groups])];
      continue;
    }
    const transferItem = (extract as { transferItem?: { item: string } }).transferItem;
    const marker: MapMarker = { id: `extract:${extract.id}`, layer: "extracts", groups, position: extract.position,
      label: extract.name, tags: extractTags(extract.name, transferItem) };
    sources.set(marker, extract);
    extracts.push(marker);
  }
  // Details wait until twins have merged, so the faction reflects every group.
  const switchNames = new Map((data.switches ?? []).map((toggle) => [toggle.id, toggle.name]));
  for (const [marker, extract] of sources) marker.details = extractDetails(extract, marker.groups, switchNames);
  for (const transit of data.transits ?? []) {
    const conditions = (transit as { conditions?: string }).conditions;
    const destination = lookups.maps?.[transit.map];
    extracts.push({ id: `transit:${transit.id}`, layer: "extracts", groups: ["transit"], position: transit.position,
      label: transit.description.replace(/^Transit to /i, "→ "), tags: ["Transit"], details: [
        destination ? { label: "Destination", value: destination } : { label: "Destination", value: transit.map, mono: true },
        ...conditions ? [{ label: "Condition", value: conditions, mono: true }] : []] });
  }
  return extracts;
}

function extractDetails(extract: Extract, groups: string[], switchNames: Map<string, string>): Detail[] {
  const transfer = (extract as { transferItem?: { item: string; count: number } }).transferItem;
  const switches = extract.switches ?? [];
  const named = switches.every((id) => switchNames.has(id));
  return [
    { label: "Faction", value: groups.length > 1 ? "Shared" : groups[0] === "scav" ? "Scav" : "PMC" },
    ...transfer ? [transfer.item === ROUBLES ? { label: "Requires", value: `${transfer.count.toLocaleString("en-US")} ₽` }
      : { label: "Requires", items: [{ id: transfer.item, count: transfer.count }] }] : [],
    ...switches.length ? [{ label: "Switch", value: (named ? switches.map((id) => switchNames.get(id)) : switches).join(", "), mono: !named }] : [],
  ];
}

/** Player spawns only; bot-only spawn points are a separate concern. */
function spawnMarkers(data: GameMapData): MapMarker[] {
  const markers: MapMarker[] = [];
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
      tags: [`${sides.map((side) => side === "pmc" ? "PMC" : "Scav").join(" & ")} spawn`,
        ...spawn.categories.includes("sniper") ? ["Sniper"] : []],
      details: [{ label: "Sides", value: spawn.sides.join(", ") }, { label: "Categories", value: spawn.categories.join(", ") },
        { label: "Zone", value: spawn.zoneName, mono: true }] });
  }
  return markers;
}

type Boss = {
  mob: string; spawnChance: number; spawnLocations?: { name: string; chance: number; positions?: Vec3[] }[];
  escorts?: { mob: string; amount: { chance: number; count: number }[] }[];
  spawnTime?: number; spawnTimeRandom?: boolean; spawnTrigger?: string | null;
};
const PMC_BOTS = new Set(["pmcBEAR", "pmcUSEC"]);
/** Filter group of a boss type; PMC bots share one. */
const bossGroup = (mob: string, normalizedName: string | undefined) => PMC_BOTS.has(mob) ? "pmcs" : normalizedName || mob;
/** Escort headcount: "2–4", or each count with its chance when there are only two. */
function escortCount(amount: { chance: number; count: number }[]) {
  const chances = new Map<number, number>();
  for (const { chance, count } of amount) chances.set(count, (chances.get(count) ?? 0) + chance);
  const counts = [...chances.keys()].sort((a, b) => a - b);
  if (counts.length <= 1) return `${counts[0] ?? 0}`;
  return counts.length === 2 ? counts.map((count) => `${count} (${percent(chances.get(count)!)})`).join(" / ") : `${counts[0]}–${counts[counts.length - 1]}`;
}
const bossTime = (seconds: number) => seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

const bossIcons: Record<string, string> = {
  "cultist-priest": "spawn_cultist-priest", rogue: "spawn_rogue", raider: "spawn_rogue",
  "black-div": "spawn_black-div", af: "spawn_af", bear: "spawn_pmc", usec: "spawn_pmc",
};

/** Boss spawn points; bosses sharing a point become one marker with an entry per boss type. */
function bossMarkers(data: GameMapData, lookups: Lookups): MapMarker[] {
  type Type = BossInfo & { miss: number; locations: Set<string>; seen: Set<number> };
  const byPoint = new Map<string, { position: Vec3; types: Map<string, Type>; counted: Set<string> }>();
  ((data.bosses ?? []) as Boss[]).forEach((boss, index) => {
    const mob = lookups.mobs?.[boss.mob];
    const group = bossGroup(boss.mob, mob?.normalizedName);
    const time = boss.spawnTime ?? -1;
    boss.spawnLocations?.forEach((location, locationIndex) => {
      for (const position of location.positions ?? []) {
        const key = posKey(position);
        const point = byPoint.get(key) ?? { position, types: new Map(), counted: new Set() };
        byPoint.set(key, point);
        // A spot listed twice in one location is still one chance.
        if (point.counted.has(`${index}|${locationIndex}`)) continue;
        point.counted.add(`${index}|${locationIndex}`);
        let type: Type | undefined = point.types.get(group);
        if (!type) {
          type = { group, name: group === "pmcs" ? "PMC bots" : mob?.name ?? boss.mob, icon: bossIcons[mob?.normalizedName ?? ""] ?? "spawn_boss",
            image: group === "pmcs" ? undefined : mob?.imagePortraitLink, chance: 0, raidChance: boss.spawnChance, entries: 0, location: "",
            escorts: [], spawnTime: time >= 0 ? `${bossTime(time)}${boss.spawnTimeRandom ? " · random" : ""}` : undefined,
            trigger: boss.spawnTrigger || undefined, miss: 1, locations: new Set(), seen: new Set() };
          point.types.set(group, type);
        }
        type.miss *= 1 - boss.spawnChance * location.chance;
        type.locations.add(location.name);
        if (type.seen.has(index)) continue;
        type.seen.add(index);
        type.entries++;
        for (const escort of boss.escorts ?? []) {
          const line = { name: lookups.mobs?.[escort.mob]?.name ?? escort.mob, count: escortCount(escort.amount) };
          if (!type.escorts.some((other) => other.name === line.name && other.count === line.count)) type.escorts.push(line);
        }
      }
    });
  });
  return [...byPoint].map(([key, { position, types }]) => {
    const bosses = [...types.values()].map(({ miss, locations, seen, ...type }): BossInfo =>
      ({ ...type, chance: 1 - miss, raidChance: type.entries === 1 ? type.raidChance : undefined, location: [...locations].join(", ") }));
    return { id: `boss:${key}`, layer: "bosses", groups: bosses.map((boss) => boss.group), position, bosses,
      label: bosses.map((boss) => boss.name).join(", "),
      tags: [...new Set(bosses.flatMap((boss) => boss.location.split(", "))), ...bosses.map((boss) => `${boss.name} ${percent(boss.chance)}`)] };
  });
}

type ArtilleryZone = { position: Vec3; outline?: Vec3[]; size?: Vec3; top?: number; botom?: number };

/** Hazards and artillery strike areas: an outline with an icon at its centre. */
function zoneMarkers(data: GameMapData): MapMarker[] {
  // Hazard ids repeat within a map, so zones are keyed by index.
  const hazards = (data.hazards ?? []).map((hazard, index): MapMarker => ({
    id: `hazard:${index}`, layer: "hazards", position: hazard.position, outline: hazard.outline, icon: "hazard",
    groups: [hazard.hazardType === "minefield" || hazard.hazardType === "sniper" ? hazard.hazardType : "other"],
    tags: [hazard.name],
    details: [{ label: "Type", value: hazard.hazardType }, ...heightDetail(hazard.top, hazard.bottom)],
  }));
  const zones = (data.artillery as { zones?: ArtilleryZone[] } | undefined)?.zones ?? [];
  const artillery = zones.map((zone, index): MapMarker => ({
    id: `artillery:${index}`, layer: "hazards", groups: ["artillery"], position: zone.position, outline: zone.outline,
    icon: "hazard_mortar", tags: ["Artillery strike zone"],
    details: [...zone.size ? [{ label: "Size", value: `${metres(zone.size.x)} × ${metres(zone.size.z)} m` }] : [], ...heightDetail(zone.top, zone.botom)],
  }));
  return [...hazards, ...artillery];
}

const containerGroups: Record<string, string[]> = {
  valuables: ["safe", "bank-safe", "shturmans-stash", "pc-block", "weapon-box", "cash-register", "bank-cash-register", "jacket", "plastic-suitcase"],
  medical: ["medbag", "medcase", "medical-supply-crate"],
  ammo: ["grenade-box", "wooden-ammo-box"],
  caches: ["buried-barrel-cache", "ground-cache"],
  supply: ["technical-supply-crate", "ration-supply-crate"],
  bodies: ["dead-scav", "scav-body", "pmc-body", "civilian-body", "lab-technician-body"],
};
const containerGroup = (name: string) =>
  Object.entries(containerGroups).find(([, names]) => names.includes(name))?.[0] ?? "general";
/** Containers without an icon of their own borrow a close one. */
const containerIconAlias: Record<string, string> = {
  "bank-safe": "safe", "shturmans-stash": "safe", "bank-cash-register": "cash-register",
  "technical-supply-crate": "crate", "ration-supply-crate": "crate", "medical-supply-crate": "crate",
  "scav-body": "dead-scav", "pmc-body": "dead-scav", "civilian-body": "dead-scav", "lab-technician-body": "dead-scav",
};

type StationaryWeapon = { stationaryWeapon: string; position: Vec3 };
type BtrStop = { name: string; x: number; y: number; z: number };

function pointMarkers(data: GameMapData, lookups: Lookups): MapMarker[] {
  const markers: MapMarker[] = [];
  const seen = new Set<string>();
  for (const container of data.lootContainers ?? []) {
    // The data repeats some containers at the same spot.
    const id = `container:${container.lootContainer}|${posKey(container.position)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const named = lookups.containers?.[container.lootContainer];
    const name = named?.normalizedName ?? "";
    markers.push({ id, layer: "containers", groups: [containerGroup(name)], position: container.position,
      icon: `container_${containerIconAlias[name] ?? (name || "crate")}`, tags: [named?.name ?? "Container"],
      details: [{ label: "Container", value: container.lootContainer, mono: true }] });
  }
  for (const lock of data.locks ?? []) {
    const group = lock.lockType === "trunk" ? "trunk" : "door";
    markers.push({ id: `lock:${lock.id}`, layer: "access", groups: [group], position: lock.position, icon: "lock",
      tags: [group === "trunk" ? "Locked trunk" : "Locked door"], details: [
        { label: "Type", value: group === "trunk" ? "Trunk" : "Door" }, { label: "Key", items: [{ id: lock.key }] },
        { label: "Needs power", value: lock.needsPower ? "Yes" : "No" }] });
  }
  const opens = new Map<string, Set<string>>();
  for (const extract of data.extracts ?? []) for (const id of extract.switches ?? []) opens.set(id, (opens.get(id) ?? new Set()).add(extract.name));
  for (const toggle of data.switches ?? []) {
    markers.push({ id: `switch:${toggle.id}`, layer: "access", groups: ["switch"], position: toggle.position,
      icon: "switch", label: toggle.name, tags: ["Switch"], details: [
        { label: "Type", value: toggle.switchType },
        ...opens.has(toggle.id) ? [{ label: "Opens", value: [...opens.get(toggle.id)!].join(", ") }] : [],
        ...toggle.activatedBy ? [{ label: "Activated by", value: compact(toggle.activatedBy), mono: true }] : [],
        ...toggle.activates?.length ? [{ label: "Activates", value: toggle.activates.map(compact).join(", "), mono: true }] : []] });
  }
  ((data.stationaryWeapons ?? []) as StationaryWeapon[]).forEach((gun, index) => markers.push({
    id: `gun:${index}`, layer: "other", groups: ["stationary"], position: gun.position, icon: "stationarygun",
    tags: [lookups.weapons?.[gun.stationaryWeapon]?.name ?? "Stationary gun"],
    details: [{ label: "Weapon", value: gun.stationaryWeapon, mono: true }],
  }));
  // BTR stops carry x/y/z flat rather than under `position`.
  ((data.btrStops ?? []) as BtrStop[]).forEach((stop, index) => markers.push({
    id: `btr:${index}`, layer: "other", groups: ["btr"], position: { x: stop.x, y: stop.y, z: stop.z },
    icon: "btr_stop", label: stop.name, tags: ["BTR stop"],
  }));
  (data.lootLoose ?? []).forEach((loot, index) => {
    // A spawn point that can hold a Battle Pass document is a document marker, not loose loot.
    const documents = [...new Set(loot.items.flatMap((item) => documentGroup.get(item) ?? []))];
    if (documents.length) {
      const labels = documents.map((key) => documentTypes.find((type) => type.key === key)!.label);
      markers.push({ id: `document:${index}`, layer: "documents", groups: documents, position: loot.position,
        tags: [`${labels.join(" / ")} document`], details: [
          { label: "Document types", value: labels.join(", ") }, { label: "Possible items", items: loot.items.map((id) => ({ id })) }] });
      return;
    }
    markers.push({ id: `loose:${index}`, layer: "loose", groups: ["loose"], position: loot.position, icon: "loose_loot",
      tags: ["Loose loot", `${loot.items.length} possible item${loot.items.length === 1 ? "" : "s"}`],
      details: [{ label: "Possible items", items: loot.items.map((id) => ({ id })) }] });
  });
  return markers;
}

/** Icon key for a marker (a file stem, or `item:<id>` for an item icon), given which of its groups are currently shown. */
export function markerIcon(marker: MapMarker, filters: Filters): string {
  if (marker.icon) return marker.icon;
  const shown = marker.groups.filter((group) => groupOn(filters[marker.layer], group));
  if (marker.bosses) return marker.bosses.find((boss) => groupOn(filters[marker.layer], boss.group))?.icon ?? "spawn_boss";
  if (marker.layer === "documents") return `item:${documentTypes.find((type) => type.key === shown[0])?.item}`;
  if (marker.layer === "spawns") return shown.includes("pmc") ? "spawn_pmc" : "spawn_scav";
  if (shown.includes("transit")) return "extract_transit";
  return shown.includes("pmc") && shown.includes("scav") ? "extract_shared" : shown.includes("scav") ? "extract_scav" : "extract_pmc";
}

/** Colour behind a marker's icon, from the first of its groups that is shown. */
export function markerTint(marker: MapMarker, filters: Filters): string | undefined {
  const shown = marker.groups.find((group) => groupOn(filters[marker.layer], group));
  return layers.find((layer) => layer.key === marker.layer)?.groups.find((group) => group.key === shown)?.tint;
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

/** Layers with the bosses layer's groups filled in from the map's markers: one per boss type, the default-on ones first. */
export function layersFor(markers: MapMarker[]): LayerDef[] {
  const groups = new Map<string, GroupDef>();
  for (const boss of markers.flatMap((marker) => marker.bosses ?? []))
    if (!groups.has(boss.group)) groups.set(boss.group, { key: boss.group, label: boss.name, icon: boss.icon, image: boss.image, off: bossOff.has(boss.group) });
  const sorted = [...groups.values()].sort((a, b) => Number(!!a.off) - Number(!!b.off));
  return layers.map((layer) => layer.key === "bosses" ? { ...layer, groups: sorted } : layer);
}

/** Whether two filter states show the same markers' switches, ignoring key order; boss types missing on one side count as default. */
export function sameFilters(a: Filters, b: Filters): boolean {
  return layers.every((layer) => {
    const keys = new Set(layer.groups.map((group) => group.key));
    if (layer.key === "bosses") for (const side of [a, b]) for (const group of Object.keys(side[layer.key]?.groups ?? {})) if (!legacyBossGroups.includes(group)) keys.add(group);
    return [...keys].every((group) => groupOn(a[layer.key], group) === groupOn(b[layer.key], group));
  });
}
