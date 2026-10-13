import type { PositionObservation } from "../bindings/PositionObservation";
import { metricProjection } from "../maps/projection.ts";
import type { PlayerPosition } from "../maps/players.ts";

export { freshness } from "../maps/players.ts";

export type PositionHistory = PositionObservation[];

/** A scanner capture as a map player position. */
export const toPlayerPosition = (position: PositionObservation): PlayerPosition => ({
  x: position.xyz[0], y: position.xyz[1], z: position.xyz[2], heading: position.heading_degrees,
  at: position.observed_at, key: `${position.filename}|${position.observed_at}`,
});

/** Positions for the current raid; unassociated captures when no raid is known. */
export function positionsForRaid(history: PositionHistory, raidId: string | null | undefined): PositionHistory {
  return history.filter((position) => (position.raid_id ?? null) === (raidId ?? null));
}

/** Uncalibrated map plane: world X → right, world Z → up (screen Y is inverted). */
export const toPlane = (position: PositionObservation) => metricProjection.toPlane(toPlayerPosition(position));

/** Capture order: filename capture minute, then receipt time. */
export function inCaptureOrder(positions: PositionHistory): PositionHistory {
  const time = (value: string | null) => value ? Date.parse(value.replace(" ", "T")) || 0 : 0;
  return [...positions].sort((a, b) => time(a.captured_at) - time(b.captured_at) || time(a.observed_at) - time(b.observed_at));
}

const captureOrder = (position: PositionObservation) =>
  Date.parse((position.captured_at ?? position.observed_at).replace(" ", "T")) || 0;

/** Replaces captures by filename with their stored versions, keeping history in capture order. */
export function upsertPositions(history: PositionHistory, stored: PositionHistory): PositionHistory {
  const byName = new Map(history.map((position) => [position.filename, position]));
  for (const position of stored) byName.set(position.filename, position);
  return [...byName.values()].sort((a, b) => captureOrder(a) - captureOrder(b));
}
