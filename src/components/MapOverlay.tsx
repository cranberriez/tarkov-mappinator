import { memo } from "react";
import { mapIcons, type MapProjection } from "../maps";
import { markerIcon, type Filters, type MapMarker } from "../lib/mapLayers";

/**
 * Data markers placed in plane units, relative to the plane origin. The caller translates this layer
 * for panning and sets `--s` (pixels per plane unit) on it for zooming, so neither re-renders the markers;
 * only filtering, a floor change or crossing the label zoom does.
 * Zones draw their outline underneath their icon. Extract names show when `labelled`; hovering any marker
 * shows its name and what it is.
 */
export const MapOverlay = memo(function MapOverlay({ markers, filters, projection, floors, floor, labelled }: {
  markers: MapMarker[]; filters: Filters; projection: MapProjection;
  /** Floor name per marker id (null = base floor) and the floor being viewed. */
  floors: Map<string, string | null>; floor: string | null;
  labelled: boolean;
}) {
  const at = (point: { x: number; z: number }) => projection.toPlane(point);
  const otherFloor = (marker: MapMarker) => (floors.get(marker.id) ?? null) !== floor;
  const zones = markers.filter((marker) => marker.outline?.length);

  return <>
    {zones.length > 0 && <svg className="overlay-zones" width="1" height="1"><g className="overlay-zones-scale">
      {zones.map((marker) => <polygon key={marker.id}
        className={`zone ${marker.groups[0]} ${otherFloor(marker) ? "other-floor" : ""}`}
        points={marker.outline!.map((point) => { const { x, y } = at(point); return `${x},${y}`; }).join(" ")} />)}
    </g></svg>}
    {markers.map((marker) => {
      const { x, y } = at(marker.position);
      const hover = [marker.label, ...marker.tags].filter(Boolean).join(" · ");
      // Only extracts keep their name on the map; everything else names itself on hover.
      const named = labelled && marker.layer === "extracts" && !!marker.label;
      return <div key={marker.id} className={`overlay-marker ${marker.layer} ${otherFloor(marker) ? "other-floor" : ""}`}
        style={{ left: `calc(${x}px * var(--s))`, top: `calc(${y}px * var(--s))` }}>
        <img src={mapIcons[markerIcon(marker, filters)] ?? mapIcons.container_crate} alt="" draggable={false} />
        {named && <span className="overlay-label">{marker.label}</span>}
        {hover && <span className={`overlay-label overlay-hover ${named ? "replaces" : ""}`}>{hover}</span>}
      </div>;
    })}
  </>;
});
