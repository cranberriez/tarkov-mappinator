import { useState } from "react";
import { CaretIcon, SwitchIcon } from "./Icons";

export type MapOption = { key: string; label: string };
/** What the dot says: the shown map is the live raid ("live"), a raid is live elsewhere ("elsewhere"), nothing is live ("idle") or the app is disconnected ("offline"). */
export type MapState = "live" | "elsewhere" | "idle" | "offline";

/**
 * Top right pill showing the map being viewed, with a dropdown list of maps to browse. Picking one shows it
 * in the map view until the view goes back to following the raid. While a raid is live elsewhere, the dot
 * and name turn into a button that jumps back to it.
 */
export function MapSwitcher({ maps, current, label, floor, state, liveName, onSelect, onSwitch }: {
  maps: MapOption[];
  /** Key of the map being shown. */
  current: string | null;
  /** Name of the map being shown, or a placeholder. */
  label: string;
  /** Name of the floor being shown, if any. */
  floor?: string;
  state: MapState;
  /** Name of the live raid's map, for the switch button. */
  liveName?: string | null;
  onSelect: (key: string) => void;
  /** Go to the live raid's map. */
  onSwitch: () => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen(!open);
  const caret = <span className="map-caret"><CaretIcon /></span>;
  const dot = <span className={`dot ${state === "elsewhere" ? "pulse warn" : state === "live" ? "ok" : state === "offline" ? "bad" : ""}`} />;
  const text = <>{label}{floor && <span className="faint">{floor}</span>}</>;
  return <div className={`map-switch ${open ? "open" : ""}`}>
    <div className="map-chip">
      {state === "elsewhere" ? <>
        <button type="button" className="map-chip-part map-chip-jump" title={`Switch to ${liveName ?? "live map"}`} onClick={onSwitch}>
          <span className="map-chip-mark">{dot}<SwitchIcon /></span>{label}
        </button>
        <button type="button" className="map-chip-part" aria-expanded={open} title={open ? "Hide maps" : "Browse maps"} onClick={toggle}>
          {floor && <span className="faint">{floor}</span>}{caret}
        </button>
      </> : <button type="button" className="map-chip-part" aria-expanded={open} title={open ? "Hide maps" : "Browse maps"} onClick={toggle}>
        <span className="map-chip-mark">{dot}</span>{text}{caret}
      </button>}
    </div>
    {open && <div className="map-switch-list" role="listbox" aria-label="Maps">
      {maps.map((map) => <button key={map.key} type="button" role="option" aria-selected={map.key === current}
        className={`floor-row ${map.key === current ? "active" : ""}`}
        onClick={() => { onSelect(map.key); setOpen(false); }}>{map.label}</button>)}
    </div>}
  </div>;
}
