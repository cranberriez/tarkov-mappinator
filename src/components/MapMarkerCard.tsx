import { assetUrl, iconSrc } from "../lib/tiles";
import { markerIcon, type Filters, type MapMarker } from "../lib/mapLayers";
import { CloseIcon } from "./Icons";

/** Item icons shown per row before the rest collapse into "+N". */
const MAX_ITEMS = 18;
const percent = (chance: number) => `${Math.round(chance * 100)}%`;

/**
 * Everything the local data knows about one marker, in the map's bottom-right corner.
 * Hovering previews it; a pinned card stays until closed.
 */
export function MapMarkerCard({ marker, filters, floorName, pinned, onClose }: {
  marker: MapMarker; filters: Filters; floorName?: string; pinned: boolean; onClose: () => void;
}) {
  const [title, ...rest] = [marker.label, ...marker.tags].filter(Boolean) as string[];
  const { x, y, z } = marker.position;
  const rows = [
    ...marker.details ?? [],
    { label: "Position", value: `X ${x.toFixed(1)} · Z ${z.toFixed(1)} · Y ${y.toFixed(1)}` },
    ...floorName ? [{ label: "Floor", value: floorName }] : [],
  ];
  return <div className="marker-card">
    <div className="marker-card-head">
      <img src={iconSrc(markerIcon(marker, filters))} alt="" draggable={false} />
      <div className="marker-card-title"><span>{title}</span>{rest.length > 0 && <span className="marker-card-sub">{rest.join(" · ")}</span>}</div>
      {pinned && <button type="button" className="icon-button" title="Close" onClick={onClose}><CloseIcon /></button>}
    </div>
    <div className="marker-card-rows">
      {rows.map((row, index) => row.boss ? <div key={index} className="marker-card-boss">
        {row.boss.image && <img src={assetUrl(row.boss.image)} alt="" draggable={false} onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />}
        <div className="marker-card-title"><span>{row.boss.name}</span><span className="marker-card-sub">
          {[`${percent(row.boss.chance)} here`, ...row.boss.raidChance !== row.boss.chance ? [`${percent(row.boss.raidChance)} per raid`] : [], row.boss.location].join(" · ")}
        </span></div>
      </div> : <div key={index} className="marker-card-row">
        <span className="marker-card-label">{row.label}</span>
        {row.items ? <div className="marker-card-items">
          {row.items.slice(0, MAX_ITEMS).map((item) => <span key={item.id} className="marker-card-item" title={item.id}>
            <img src={iconSrc(`item:${item.id}`)} alt={item.id} draggable={false} onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
            {(item.count ?? 1) > 1 && <span className="count">{item.count}</span>}
          </span>)}
          {row.items.length > MAX_ITEMS && <span className="marker-card-label">+{row.items.length - MAX_ITEMS}</span>}
        </div> : <span className={row.mono ? "marker-card-id" : undefined}>{row.value}</span>}
      </div>)}
    </div>
  </div>;
}
