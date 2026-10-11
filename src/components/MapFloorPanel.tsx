export type FloorOption = { key: string; label: string };

/**
 * Floor picker above the map toolbar. Open: one row per floor; clicking a floor shows only it, clicking it
 * again goes back to all floors. Closed: just the floor being shown, which opens the picker when clicked.
 */
export function MapFloorPanel({ floors, current, following, open, onOpen, onSelect }: {
  floors: FloorOption[];
  /** Floor key being shown, or null for all floors. */
  current: string | null;
  /** The floor is picked by following the player. */
  following: boolean;
  open: boolean; onOpen: (open: boolean) => void; onSelect: (key: string | null) => void;
}) {
  const label = floors.find((floor) => floor.key === current)?.label ?? "All floors";
  if (!open) {
    return <button type="button" className="map-floor-chip" title="Choose floor" onClick={() => onOpen(true)}>
      {label}
    </button>;
  }
  return <div className="map-floors" role="listbox" aria-label="Floors">
    {floors.map((floor) => {
      const selected = floor.key === current;
      return <button key={floor.key} type="button" role="option" aria-selected={selected}
        className={`floor-row ${selected ? "active" : ""} ${selected && following ? "following" : ""}`}
        title={selected ? "Show all floors" : `Show only ${floor.label}`}
        onClick={() => onSelect(selected ? null : floor.key)}>{floor.label}</button>;
    })}
  </div>;
}
