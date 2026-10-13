import type { RaidState } from "../bindings/RaidState";
import type { RaidRecord } from "../bindings/RaidRecord";

export type { RaidRecord };

/** Log timestamps are naive local "YYYY-MM-DD HH:MM:SS.fff"; RFC 3339 also accepted. */
export function parseTime(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(" ", "T") : value);
}

/** Replaces records by ID with their stored versions; newest first. */
export function upsertRaids(records: RaidRecord[], stored: RaidRecord[]): RaidRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of stored) byId.set(record.id, record);
  // The store drops a legacy placeholder once the real raid with its start time arrives.
  const starts = new Set(stored.map((record) => record.started_at));
  return [...byId.values()]
    .filter((record) => !(record.id.startsWith("log:") && starts.has(record.started_at)))
    .sort((a, b) => parseTime(b.started_at) - parseTime(a.started_at));
}

/** Raid IDs are "local:<session>:<start timestamp>". */
export function raidStartFromId(id: string): string | null {
  const parts = id.split(":");
  return parts.length >= 3 && parts[0] === "local" ? parts.slice(2).join(":") : null;
}

export type RaidStatus = "active" | "ended" | "unknown";

export function raidStatus(record: RaidRecord, index: number, current: RaidState | undefined): RaidStatus {
  if (record.ended_at) return "ended";
  return index === 0 && current?.id === record.id && current.lifecycle === "active" ? "active" : "unknown";
}

/** 30 pastel hues spaced by the golden angle so neighbours contrast. */
export const raidPalette = Array.from({ length: 30 }, (_, index) => {
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue} ${58 + (index % 3) * 6}% ${74 + (index % 2) * 4}%)`;
});

/** Keyed on start time so a backfilled raid keeps its colour when the live ID replaces it. */
export function raidColor(record: Pick<RaidRecord, "started_at">): string {
  const key = String(parseTime(record.started_at));
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return raidPalette[(hash >>> 0) % raidPalette.length];
}
