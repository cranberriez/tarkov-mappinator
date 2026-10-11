import { useState } from "react";
import { MapIcon } from "./Icons";

export type MapOption = { key: string; label: string };

/**
 * Inset square button that opens a list of maps to browse. Picking one shows it in the map view until
 * the view goes back to following the raid.
 */
export function MapSwitcher({ maps, current, onSelect }: {
  maps: MapOption[];
  /** Key of the map being shown. */
  current: string | null;
  onSelect: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return <div className="map-switch">
    <button type="button" className={`map-switch-button ${open ? "active" : ""}`} aria-expanded={open}
      title={open ? "Hide maps" : "Browse maps"} onClick={() => setOpen(!open)}><MapIcon /></button>
    {open && <div className="map-switch-list" role="listbox" aria-label="Maps">
      {maps.map((map) => <button key={map.key} type="button" role="option" aria-selected={map.key === current}
        className={`floor-row ${map.key === current ? "active" : ""}`}
        onClick={() => { onSelect(map.key); setOpen(false); }}>{map.label}</button>)}
    </div>}
  </div>;
}
