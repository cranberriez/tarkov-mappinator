import type { ActivityEvent } from "../bindings/ActivityEvent";
import type { RaidState } from "../bindings/RaidState";
import type { ImportedRaid } from "../bindings/ImportedRaid";

export type RaidRecord = {
  id: string;
  map: string | null;
  game_mode: string | null;
  player_role: string | null;
  started_at: string;
  /** null while active, or when no end was ever observed. */
  ended_at: string | null;
};

const MAX_RAIDS = 500;
const SAME_MOMENT_MS = 1500;

/** Log timestamps are naive local "YYYY-MM-DD HH:MM:SS.fff"; RFC 3339 also accepted. */
export function parseTime(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(" ", "T") : value);
}

const isStart = (event: ActivityEvent) => event.kind === "raid" && event.action === "started";
const isEnd = (event: ActivityEvent) => event.kind === "raid" && (event.action === "ended" || event.action === "end_reported");

/**
 * Merges what the scanner currently knows into the persisted raid list:
 * the current raid (richest: map, mode, role) and raid start/end activity (backfill, no map).
 * Newest first.
 */
export function observeRaids(records: RaidRecord[], raid: RaidState | undefined, activity: ActivityEvent[], now = Date.now()): RaidRecord[] {
  const next = records.map((record) => ({ ...record }));
  const findAt = (time: number) => next.find((record) => Math.abs(parseTime(record.started_at) - time) < SAME_MOMENT_MS);

  for (const event of activity.filter(isStart)) {
    const time = parseTime(event.logged_at);
    if (Number.isNaN(time) || findAt(time)) continue;
    next.push({ id: `log:${event.logged_at}`, map: null, game_mode: null, player_role: null, started_at: event.logged_at, ended_at: null });
  }

  if (raid?.id && raid.started_at && raid.lifecycle !== "unknown") {
    const time = parseTime(raid.started_at);
    const existing = next.find((record) => record.id === raid.id) ?? findAt(time);
    const record = existing ?? { id: raid.id, map: null, game_mode: null, player_role: null, started_at: raid.started_at, ended_at: null };
    // The live raid's ID is canonical; it replaces a backfilled placeholder for the same start.
    record.id = raid.id;
    record.map = raid.map ?? record.map;
    record.game_mode = raid.game_mode ?? record.game_mode;
    record.player_role = raid.player_role ?? record.player_role;
    if (!existing) next.push(record);
  }

  next.sort((a, b) => parseTime(b.started_at) - parseTime(a.started_at));

  // An end belongs to the latest raid that started before it; it cannot reach past the next start.
  const ends = activity.filter(isEnd).map((event) => event.logged_at).sort((a, b) => parseTime(a) - parseTime(b));
  next.forEach((record, index) => {
    if (record.ended_at) return;
    const start = parseTime(record.started_at);
    const limit = index > 0 ? parseTime(next[index - 1].started_at) : Infinity;
    const end = ends.find((value) => parseTime(value) >= start && parseTime(value) < limit);
    if (end) record.ended_at = end;
    else if (index === 0 && raid?.id === record.id && raid.lifecycle === "ended") record.ended_at = new Date(now).toISOString();
  });

  return next.slice(0, MAX_RAIDS);
}

/** Folds imported raids in; IDs match live ones, start time catches backfilled placeholders. */
export function mergeImportedRaids(records: RaidRecord[], imported: ImportedRaid[]): RaidRecord[] {
  const next = records.map((record) => ({ ...record }));
  for (const raid of imported) {
    const time = parseTime(raid.started_at);
    const existing = next.find((record) => record.id === raid.id || Math.abs(parseTime(record.started_at) - time) < SAME_MOMENT_MS);
    if (existing) {
      existing.id = raid.id;
      existing.map ??= raid.map;
      existing.game_mode ??= raid.game_mode;
      existing.ended_at ??= raid.ended_at;
    } else {
      next.push({ id: raid.id, map: raid.map, game_mode: raid.game_mode, player_role: null, started_at: raid.started_at, ended_at: raid.ended_at });
    }
  }
  return next.sort((a, b) => parseTime(b.started_at) - parseTime(a.started_at)).slice(0, MAX_RAIDS);
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
