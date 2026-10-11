export function timestamp(value: string | null | undefined, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function clock(value: string | null | undefined, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function age(value: string | null | undefined, now: number) {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export const lifecycleLabel: Record<string, string> = {
  unknown: "No raid", loading: "Loading", active: "In raid", ended: "Raid ended",
};

export function span(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
