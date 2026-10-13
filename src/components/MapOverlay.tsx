import { memo, useMemo, type CSSProperties } from "react";
import { mapIcons, type MapProjection } from "../maps";
import { iconSrc } from "../lib/tiles";
import { markerIcon, markerTint, type Filters, type MapMarker } from "../lib/mapLayers";

/** Layers thick enough to crowd the map; their markers give way to anything else that would overlap them. */
const DENSE = new Set(["containers", "loose"]);
/** Screen size (pixels) of the cell a dense marker needs to itself. */
const CELL_PX = 12;

/** Part of the plane to draw markers in, and the zoom (pixels per plane unit) to thin them for. */
export type OverlayArea = { x: number; y: number; width: number; height: number; scale: number };

/**
 * Data markers placed in plane units, relative to the plane origin. The caller translates this layer
 * for panning and sets `--s` (pixels per plane unit) on it for zooming, so neither re-renders the markers;
 * only filtering, a floor change or crossing the label zoom does.
 * Zones draw their outline underneath their icon. Extract names show when `labelled`; hovering any marker
 * shows its name and what it is.
 * With `area`, only markers inside it are drawn, and a dense marker is left out where something drawn before it
 * already holds its cell: others first, then those on the shown floor, then containers before loose loot.
 * Cells are fixed to the plane, so panning never changes which marker wins one.
 */
export const MapOverlay = memo(function MapOverlay({ markers, filters, projection, floors, floor, shift, labelled, area }: {
  markers: MapMarker[]; filters: Filters; projection: MapProjection;
  /** Floor name per marker id (null = base floor), and the floor shown: a name, null for the base, undefined for all. */
  floors: Map<string, string | null>; floor: string | null | undefined;
  /** How far a thing on a floor moves sideways (plane units) when floors are split apart; it moves with its building's floor. */
  shift?: (floor: string | null, x: number, y: number) => number;
  labelled: boolean; area: OverlayArea | null;
}) {
  const shiftOf = (marker: MapMarker) => {
    const { x, y } = projection.toPlane(marker.position);
    return shift?.(floors.get(marker.id) ?? null, x, y) ?? 0;
  };
  const at = (point: { x: number; z: number }, dx = 0) => { const plane = projection.toPlane(point); return { x: plane.x + dx, y: plane.y }; };
  const otherFloor = (marker: MapMarker) => floor !== undefined && (floors.get(marker.id) ?? null) !== floor;
  const zones = markers.filter((marker) => marker.outline?.length);
  const placed = useMemo(() => {
    const all = markers.map((marker) => ({ marker, ...at(marker.position, shiftOf(marker)) }));
    if (!area) return all;
    const inside = all.filter(({ x, y }) => x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height);
    const cell = CELL_PX / area.scale;
    const rank = ({ marker }: typeof inside[number]) => !DENSE.has(marker.layer) ? 0 : (otherFloor(marker) ? 2 : 0) + (marker.layer === "loose" ? 2 : 1);
    const taken = new Set<string>(), kept = new Set<typeof inside[number]>();
    for (const entry of [...inside].sort((a, b) => rank(a) - rank(b))) {
      const key = `${Math.floor(entry.x / cell)}|${Math.floor(entry.y / cell)}`;
      if (DENSE.has(entry.marker.layer) && taken.has(key)) continue;
      taken.add(key);
      kept.add(entry);
    }
    // Drawn in their original order, so what sits on top stays the same.
    return inside.filter((entry) => kept.has(entry));
  }, [markers, projection, floors, floor, shift, area]);

  return <>
    {zones.length > 0 && <svg className="overlay-zones" width="1" height="1"><g className="overlay-zones-scale">
      {zones.map((marker) => <polygon key={marker.id}
        className={`zone ${marker.groups[0]} ${otherFloor(marker) ? "other-floor" : ""}`}
        points={marker.outline!.map((point) => { const { x, y } = at(point, shiftOf(marker)); return `${x},${y}`; }).join(" ")} />)}
    </g></svg>}
    {placed.map(({ marker, x, y }) => {
      const tint = markerTint(marker, filters);
      const hover = [marker.label, ...marker.tags].filter(Boolean).join(" · ");
      // Only extracts keep their name on the map; everything else names itself on hover.
      const named = labelled && marker.layer === "extracts" && !!marker.label;
      return <div key={marker.id} className={`overlay-marker ${marker.layer} ${otherFloor(marker) ? "other-floor" : ""}`}
        style={{ left: `calc(${x}px * var(--s))`, top: `calc(${y}px * var(--s))` }}>
        <img src={iconSrc(markerIcon(marker, filters)) ?? mapIcons.container_crate} alt="" draggable={false}
          className={tint ? "tinted" : undefined} style={tint ? { "--tint": tint } as CSSProperties : undefined} />
        {named && <span className="overlay-label">{marker.label}</span>}
        {hover && <span className={`overlay-label overlay-hover ${named ? "replaces" : ""}`}>{hover}</span>}
      </div>;
    })}
  </>;
});
