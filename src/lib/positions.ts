import type { PositionObservation } from "../bindings/PositionObservation";

export type PositionHistory = PositionObservation[];

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

/** Replaces captures by filename with their stored versions, keeping history in capture order. */
export function upsertPositions(history: PositionHistory, stored: PositionHistory): PositionHistory {
  const byName = new Map(history.map((position) => [position.filename, position]));
  for (const position of stored) byName.set(position.filename, position);
  return [...byName.values()].sort((a, b) => captureOrder(a) - captureOrder(b));
}
