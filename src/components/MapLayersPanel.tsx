import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { mapIcons } from "../maps";
import { layers, layerState, sameFilters, toggleLayer, type Filters } from "../lib/mapLayers";
import { keys, load, save } from "../lib/persist";
import { CaretIcon, PinIcon, ResetIcon } from "./Icons";

const PRESET_SLOTS = 3;

/**
 * Tiered marker filter: each layer row switches the whole layer, the rows under it switch its groups.
 * Groups the current map has no markers for are left out. Layers fold behind a caret; three preset
 * slots save and restore the switches (right click a saved slot to overwrite or clear it).
 */
export function MapLayersPanel({ filters, defaults, counts, open, onOpen, onChange }: {
  filters: Filters; defaults: Filters; counts: Record<string, number>; open: boolean;
  onOpen: (open: boolean) => void; onChange: (filters: Filters) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => load(keys.mapLayersCollapsed, {}));
  useEffect(() => save(keys.mapLayersCollapsed, collapsed), [collapsed]);
  const [presets, setPresets] = useState<(Filters | null)[]>(() => {
    const stored = load<(Filters | null)[]>(keys.mapPresets, []);
    return Array.from({ length: PRESET_SLOTS }, (_, index) => stored[index] ?? null);
  });
  useEffect(() => save(keys.mapPresets, presets), [presets]);
  const [menu, setMenu] = useState<{ slot: number; x: number; y: number } | null>(null);

  const setPreset = (slot: number, value: Filters | null) =>
    setPresets((current) => current.map((preset, index) => index === slot ? value : preset));

  const shown = layers.filter((layer) => counts[layer.key]);
  const setGroup = (key: string, group: string, on: boolean) => onChange({
    ...filters, [key]: { groups: { ...filters[key].groups, [group]: on } },
  });

  return <div className={`map-layers ${open ? "open" : ""}`}>
    <div className="layers-bar">
      <button type="button" className={`icon-button ${open ? "active" : ""}`} aria-expanded={open}
        title={open ? "Hide map layers" : "Map layers"} onClick={() => onOpen(!open)}><PinIcon /></button>
      {open && <>
        <div className="presets">
          {presets.map((preset, slot) => {
            const active = !!preset && sameFilters(preset, filters);
            return <button key={slot} type="button" className={`preset ${preset ? "saved" : ""} ${active ? "active" : ""}`}
              title={preset ? `Preset ${slot + 1} · right click for options` : `Save as preset ${slot + 1}`}
              onClick={() => preset ? onChange(structuredClone(preset)) : setPreset(slot, structuredClone(filters))}
              onContextMenu={(event) => {
                event.preventDefault();
                if (preset) setMenu({ slot, x: event.clientX, y: event.clientY });
              }}>{slot + 1}</button>;
          })}
        </div>
        <button type="button" className="icon-button" title="Reset to defaults" disabled={sameFilters(filters, defaults)}
          onClick={() => onChange(structuredClone(defaults))}><ResetIcon /></button>
      </>}
    </div>
    {open && (shown.length ? shown.map((layer) => {
      const state = filters[layer.key];
      const folded = collapsed[layer.key] ?? !!layer.folded;
      // The header speaks for the groups this map has.
      const present = layer.groups.filter((group) => counts[`${layer.key}.${group.key}`]);
      const status = layerState(state, present.map((group) => group.key));
      return <div key={layer.key} className={`layer ${status}`}>
        <div className="layer-head">
          <button type="button" className={`caret ${folded ? "folded" : ""}`} aria-expanded={!folded}
            title={folded ? `Expand ${layer.label}` : `Collapse ${layer.label}`}
            onClick={() => setCollapsed((current) => ({ ...current, [layer.key]: !folded }))}><CaretIcon /></button>
          <button type="button" className="layer-row" aria-pressed={status === "mixed" ? "mixed" : status === "on"} aria-label={layer.label}
            title={status === "off" ? `Show all ${layer.label.toLowerCase()}` : `Hide all ${layer.label.toLowerCase()}`}
            onClick={() => onChange({ ...filters, [layer.key]: toggleLayer(state, present.map((group) => group.key)) })}>
            <span className="layer-name">{layer.label}</span>
            <span className="faint">{counts[layer.key]}</span>
          </button>
        </div>
        {!folded && <div className="layer-groups">
          {present.map((group) => {
            const on = state.groups[group.key];
            return <button key={group.key} type="button" className={`layer-row group ${on ? "" : "off"}`} aria-pressed={on}
              title={group.label} onClick={() => setGroup(layer.key, group.key, !on)}>
              <img src={mapIcons[group.icon]} alt="" />
              <span className="group-name">{group.label}</span>
              <span className="faint">{counts[`${layer.key}.${group.key}`]}</span>
            </button>;
          })}
        </div>}
      </div>;
    }) : <p className="layer-empty faint">No map data</p>)}
    {menu && <PresetMenu {...menu} onClose={() => setMenu(null)}
      onOverwrite={() => setPreset(menu.slot, structuredClone(filters))} onClear={() => setPreset(menu.slot, null)} />}
  </div>;
}

function PresetMenu({ slot, x, y, onClose, onOverwrite, onClear }: {
  slot: number; x: number; y: number; onClose: () => void; onOverwrite: () => void; onClear: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    // Deferred so the opening right click doesn't close it straight away.
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("blur", close);
    });
    window.addEventListener("keydown", escape);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  const act = (action: () => void) => () => { action(); onClose(); };
  // Portalled: the panel's backdrop filter would otherwise anchor `position: fixed` to the panel.
  return createPortal(<div className="context-menu" role="menu" style={{ left: x, top: y }}
    onPointerDown={(event) => event.stopPropagation()}>
    <span className="context-title faint">Preset {slot + 1}</span>
    <button type="button" role="menuitem" onClick={act(onOverwrite)}>Overwrite preset</button>
    <button type="button" role="menuitem" className="danger" onClick={act(onClear)}>Clear preset</button>
  </div>, document.body);
}
