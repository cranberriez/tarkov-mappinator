import { memo, type CSSProperties } from "react";
import { mapIcons, type MapProjection } from "../maps";
import { iconSrc } from "../lib/tiles";
import { markerIcon, markerTint, type Filters, type MapMarker } from "../lib/mapLayers";

/**
 * Data markers placed in plane units, relative to the plane origin. The caller translates this layer
 * for panning and sets `--s` (pixels per plane unit) on it for zooming, so neither re-renders the markers;
 * only filtering, a floor change or crossing the label zoom does.
 * Zones draw their outline underneath their icon. Extract names show when `labelled`; hovering any marker
 * shows its name and what it is.
 */
export const MapOverlay = memo(function MapOverlay({ markers, filters, projection, floors, floor, shift, labelled }: {
  markers: MapMarker[]; filters: Filters; projection: MapProjection;
  /** Floor name per marker id (null = base floor), and the floor shown: a name, null for the base, undefined for all. */
  floors: Map<string, string | null>; floor: string | null | undefined;
  /** How far a thing on a floor moves sideways (plane units) when floors are split apart; it moves with its building's floor. */
  shift?: (floor: string | null, x: number, y: number) => number;
  labelled: boolean;
}) {
  const shiftOf = (marker: MapMarker) => {
    const { x, y } = projection.toPlane(marker.position);
    return shift?.(floors.get(marker.id) ?? null, x, y) ?? 0;
  };
  const at = (point: { x: number; z: number }, dx = 0) => { const plane = projection.toPlane(point); return { x: plane.x + dx, y: plane.y }; };
  const otherFloor = (marker: MapMarker) => floor !== undefined && (floors.get(marker.id) ?? null) !== floor;
  const zones = markers.filter((marker) => marker.outline?.length);

  return <>
    {zones.length > 0 && <svg className="overlay-zones" width="1" height="1"><g className="overlay-zones-scale">
      {zones.map((marker) => <polygon key={marker.id}
        className={`zone ${marker.groups[0]} ${otherFloor(marker) ? "other-floor" : ""}`}
        points={marker.outline!.map((point) => { const { x, y } = at(point, shiftOf(marker)); return `${x},${y}`; }).join(" ")} />)}
    </g></svg>}
    {markers.map((marker) => {
      const { x, y } = at(marker.position, shiftOf(marker));
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
