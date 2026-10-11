import type { PositionObservation } from "../bindings/PositionObservation";

export type PositionHistory = PositionObservation[];

const MAX_POSITIONS = 5000;
const key = (position: PositionObservation) => `${position.filename}|${position.observed_at}`;

/** The backend only exposes the latest position, so history accumulates client-side. */
export function appendPosition(history: PositionHistory, position: PositionObservation): PositionHistory {
  const last = history[history.length - 1];
  if (last && key(last) === key(position)) return history;
  if (history.some((entry) => key(entry) === key(position))) return history;
  const next = [...history, position];
  return next.length > MAX_POSITIONS ? next.slice(next.length - MAX_POSITIONS) : next;
}

/** Positions for the current raid; unassociated captures when no raid is known. */
export function positionsForRaid(history: PositionHistory, raidId: string | null | undefined): PositionHistory {
  return history.filter((position) => (position.raid_id ?? null) === (raidId ?? null));
}

/** 1 when just received, easing to 0 over `window` milliseconds. */
export function freshness(observedAt: string, now: number, window = 120_000): number {
  const time = Date.parse(observedAt);
  if (Number.isNaN(time)) return 0;
  return Math.min(1, Math.max(0, 1 - (now - time) / window));
}

/** Map plane: world X → right, world Z → up (screen Y is inverted). */
export const toPlane = (position: PositionObservation) => ({ x: position.xyz[0], y: -position.xyz[2] });

const captureOrder = (position: PositionObservation) =>
  Date.parse((position.captured_at ?? position.observed_at).replace(" ", "T")) || 0;

/** Adds imported captures not already known (by filename), keeping history in capture order. */
export function mergePositions(history: PositionHistory, incoming: PositionHistory): PositionHistory {
  const known = new Set(history.map((position) => position.filename));
  const fresh = incoming.filter((position) => !known.has(position.filename));
  if (!fresh.length) return history;
  const next = [...history, ...fresh].sort((a, b) => captureOrder(a) - captureOrder(b));
  return next.length > MAX_POSITIONS ? next.slice(next.length - MAX_POSITIONS) : next;
}
