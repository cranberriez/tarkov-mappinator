import data from "./calibration.json" with { type: "json" };
import type { MapCalibration } from "./types.ts";

export const mapSources = data.source;
export const maps = data.maps as unknown as Record<string, MapCalibration>;

const byAlias = new Map<string, MapCalibration>();
for (const map of Object.values(maps)) for (const alias of map.aliases) byAlias.set(alias, map);

/**
 * Finds the calibrated map for any known name: tarkov.dev key ("customs"), game id ("bigmap"),
 * scene name ("customs_preset", "maps/customs_preset.bundle") or English name ("Customs").
 */
export function resolveMap(name: string | null | undefined): MapCalibration | null {
  if (!name) return null;
  const key = name.trim().toLowerCase().replace(/^maps\//, "").replace(/\.bundle$/, "");
  return byAlias.get(key) ?? null;
}
