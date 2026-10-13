/** Small localStorage helpers for UI preferences. Raid history lives in the backend store; `positions` and `raids` are read once to migrate it. */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or privacy mode: history simply stays in memory.
  }
}

export const keys = { positions: "history:positions:v1", raids: "history:raids:v1", mapStyle: "map:style:v1", mapLayers: "map:layers:v1", mapLayersOpen: "map:layers-open:v1", mapLayersCollapsed: "map:layers-collapsed:v1", mapPresets: "map:presets:v1", mapFloorsOpen: "map:floors-open:v1", mapSplit: "map:split:v1", miniStartup: "mini:startup:v1", miniPosition: "mini:position:v1", fullBounds: "window:full-bounds:v1", companionEnabled: "companion:enabled:v1", autoShot: "autoshot:config:v1", shotCleanup: "screenshots:delete-after-raid:v1", toasts: "notifications:toasts:v1", valuableLoot: "map:valuable-loot:v1" } as const;
