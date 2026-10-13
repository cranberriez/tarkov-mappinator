import { assetUrl, iconSrc } from "../lib/tiles";
import { groupOn, markerIcon, type Detail, type Filters, type MapMarker } from "../lib/mapLayers";
import { CloseIcon } from "./Icons";

/** Item icons shown per row before the rest collapse into "+N". */
const MAX_ITEMS = 18;
const percent = (chance: number) => `${Math.round(chance * 100)}%`;

/**
 * Everything the local data knows about one marker, in the map's bottom-right corner.
 * Hovering previews it; a pinned card stays until closed. A boss spawn point stacks one panel per
 * shown boss type, then one with the place itself.
 */
export function MapMarkerCard({ marker, filters, floorName, pinned, onClose }: {
  marker: MapMarker; filters: Filters; floorName?: string; pinned: boolean; onClose: () => void;
}) {
  const [title, ...rest] = [marker.label, ...marker.tags].filter(Boolean) as string[];
  const { x, y, z } = marker.position;
  const place: Detail[] = [
    { label: "Position", value: `X ${x.toFixed(1)} · Z ${z.toFixed(1)} · Y ${y.toFixed(1)}` },
    ...floorName ? [{ label: "Floor", value: floorName }] : [],
  ];
  const close = pinned && <button type="button" className="icon-button" title="Close" onClick={onClose}><CloseIcon /></button>;
  if (marker.bosses) {
    const bosses = marker.bosses.filter((boss) => groupOn(filters[marker.layer], boss.group));
    const places = [...new Set(marker.bosses.flatMap((boss) => boss.location.split(", ")))].join(" · ");
    return <div className="marker-cards">
      {bosses.map((boss, index) => <div key={boss.group} className="marker-card">
        <div className="marker-card-head marker-card-boss">
          {boss.image && <img src={assetUrl(boss.image)} alt="" draggable={false} onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />}
          <div className="marker-card-title"><span>{boss.name}</span><span className="marker-card-sub">
            {[`${percent(boss.chance)} here`, ...boss.raidChance !== undefined && boss.raidChance !== boss.chance ? [`${percent(boss.raidChance)} per raid`] : [],
              boss.location, ...boss.entries > 1 ? [`${boss.entries} spawn entries`] : []].join(" · ")}
          </span></div>
          {index === 0 && close}
        </div>
        <Rows rows={[...boss.escorts.map((escort) => ({ label: "Escorts", value: `${escort.name} ${escort.count}` })),
          ...boss.spawnTime ? [{ label: "Spawn time", value: boss.spawnTime }] : [],
          ...boss.trigger ? [{ label: "Trigger", value: boss.trigger, mono: true }] : []]} />
      </div>)}
      <div className="marker-card">
        {!bosses.length && <div className="marker-card-head"><div className="marker-card-title"><span>{places}</span></div>{close}</div>}
        {bosses.length > 0 && <div className="marker-card-title"><span>{places}</span></div>}
        <Rows rows={place} />
      </div>
    </div>;
  }
  return <div className="marker-cards"><div className="marker-card">
    <div className="marker-card-head">
      <img src={iconSrc(markerIcon(marker, filters))} alt="" draggable={false} />
      <div className="marker-card-title"><span>{title}</span>{rest.length > 0 && <span className="marker-card-sub">{rest.join(" · ")}</span>}</div>
      {close}
    </div>
    <Rows rows={[...marker.details ?? [], ...place]} />
  </div></div>;
}

function Rows({ rows }: { rows: Detail[] }) {
  return rows.length > 0 ? <div className="marker-card-rows">
    {rows.map((row, index) => <div key={index} className="marker-card-row">
      <span className="marker-card-label">{row.label}</span>
      {row.items ? <div className="marker-card-items">
        {row.items.slice(0, MAX_ITEMS).map((item) => <span key={item.id} className="marker-card-item" title={item.id}>
          <img src={iconSrc(`item:${item.id}`)} alt={item.id} draggable={false} onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
          {(item.count ?? 1) > 1 && <span className="count">{item.count}</span>}
        </span>)}
        {row.items.length > MAX_ITEMS && <span className="marker-card-label">+{row.items.length - MAX_ITEMS}</span>}
      </div> : <span className={row.mono ? "marker-card-id" : undefined}>{row.value}</span>}
    </div>)}
  </div> : null;
}
