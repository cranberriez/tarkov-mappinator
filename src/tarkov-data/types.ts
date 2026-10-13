// Shapes of the tarkov.dev documents as stored locally (names already translated to English).
// Only fields the app is likely to use are typed; the documents carry more.

export type Vec3 = { x: number; y: number; z: number };

/** Volume: footprint polygon in world x/z plus a height band. */
export type Zone = { position: Vec3; outline?: Vec3[]; top?: number; bottom?: number };

export type Extract = Zone & {
  id: string;
  name: string;
  faction: "pmc" | "scav" | "shared" | string;
  switch?: boolean;
  switches?: string[];
};

export type Transit = Zone & { id: string; description: string; map: string };
export type Spawn = { position: Vec3; sides: string[]; categories: string[]; zoneName: string };
export type Lock = { id: string; lockType: string; key: string; needsPower: boolean; position: Vec3 };
export type Hazard = Zone & { id?: string; hazardType: string; name: string };
export type MapSwitch = Zone & { id: string; name: string; switchType: string; activatedBy: unknown; activates: unknown[] };
export type ContainerSpawn = { lootContainer: string; position: Vec3 };
export type LooseLoot = { position: Vec3; items: string[] };

export type GameMapData = {
  id: string;
  name: string;
  normalizedName: string;
  nameId: string;
  scenePath: string;
  wiki: string;
  raidDuration: number;
  players: string;
  /** Degrees from world axes to the in-game compass. */
  coordinateToCardinalRotation: number;
  enemies: string[];
  bosses: unknown[];
  spawns: Spawn[];
  extracts: Extract[];
  transits: Transit[];
  locks: Lock[];
  hazards: Hazard[];
  switches: MapSwitch[];
  lootContainers: ContainerSpawn[];
  lootLoose: LooseLoot[];
  stationaryWeapons: unknown[];
  btrStops: unknown[];
  artillery?: unknown;
  minPlayerLevel: number;
  maxPlayerLevel: number;
  accessKeys: string[];
  accessKeysMinPlayerLevel: number;
};

export type LootContainer = { id: string; name: string; normalizedName: string };
export type StationaryWeapon = { id: string; name: string; shortName: string; normalizedName: string };

export type CommonData = {
  lootContainers: Record<string, LootContainer>;
  stationaryWeapons: Record<string, StationaryWeapon>;
  goonReports: { map: string; timestamp: string }[];
};

/** One `mobs.json` entry (boss, follower, PMC bot), keyed by mob id such as "bossBully". */
export type Mob = {
  id: string; name: string; normalizedName: string; imagePortraitLink?: string; imagePosterLink?: string;
  health?: { bodyPart: string; id: string; max: number }[];
  /** Loadout tree of `{ attributes, contains?, count, item }`, item ids. */
  equipment?: unknown[];
  items?: { id: string; attributes?: { difficulty?: string; prevalence?: number } }[];
};
