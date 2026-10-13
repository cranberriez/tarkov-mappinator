import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HistoryData } from "../bindings/HistoryData";
import type { HistoryStats } from "../bindings/HistoryStats";
import type { CleanupPlan } from "../bindings/CleanupPlan";
import type { CleanupKind } from "../bindings/CleanupKind";
import type { PositionObservation } from "../bindings/PositionObservation";
import { keys } from "./persist";

export type { HistoryData, HistoryStats, CleanupPlan, CleanupKind };

/** Raid and position history lives in the backend's SQLite store. */
export const loadHistory = () => invoke<HistoryData>("history_load");
export const getHistoryStats = () => invoke<HistoryStats>("history_stats");
export const clearHistory = () => invoke<void>("history_clear");
export const getCleanupPlan = () => invoke<CleanupPlan>("cleanup_plan");
/** Moves stored-and-imported game files to the Recycle Bin; resolves to how many moved. */
export const runCleanup = (kind: CleanupKind) => invoke<number>("cleanup_run", { kind });
/** History, map tiles, map data and paired sites. Preferences are separate: `resetPreferences`. */
export const clearAllData = () => invoke<void>("clear_all_data");

/** Rows as stored after monitoring observed something. */
export const onHistoryUpdated = (handler: (delta: HistoryData) => void) =>
  listen<HistoryData>("history:updated", ({ payload }) => handler(payload));
/** Bulk change (import, clear): reload everything. */
export const onHistoryReset = (handler: () => void) => listen("history:reset", () => handler());

/** Moves history the UI used to keep in localStorage into the store, once. */
export async function migrateLegacyHistory() {
  const raids = localStorage.getItem(keys.raids);
  const positions = localStorage.getItem(keys.positions);
  if (!raids && !positions) return;
  try {
    await invoke("history_migrate", {
      raids: raids ? JSON.parse(raids) : [],
      positions: positions ? JSON.parse(positions) as PositionObservation[] : [],
    });
  } catch (cause) {
    // Unreadable leftovers are dropped rather than retried on every launch.
    if (!(cause instanceof SyntaxError)) throw cause;
  }
  localStorage.removeItem(keys.raids);
  localStorage.removeItem(keys.positions);
}

/** Forgets every UI preference (window, map, mini mode, connection, auto-screenshot) and reloads. */
export async function resetPreferences() {
  // The site connection is off by default; auto-screenshot re-applies its default on reload.
  await invoke("companion_stop").catch(() => {});
  localStorage.clear();
  window.location.reload();
}
