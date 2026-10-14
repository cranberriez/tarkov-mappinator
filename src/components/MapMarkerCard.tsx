import type { ReactNode } from "react";
import { documentPhoto, groupOn, markerIcon, tarkovPreset, useMapAssets, type Detail, type Filters, type MapMarker, type MarkerPreset } from "../maps";
import { formatRoubles, itemValue, type ItemGet } from "../lib/itemData";
import { CloseIcon } from "./Icons";

/** Item icons shown per row before the rest collapse into "+N". */
const MAX_ITEMS = 18;
const percent = (chance: number) => `${Math.round(chance * 100)}%`;

/**
 * Everything the local data knows about one marker, in the map's bottom-right corner.
 * Hovering previews it; a pinned card stays until closed. A boss spawn point stacks one panel per
 * shown boss type, then one with the place itself.
 */
export function MapMarkerCard({ marker, filters, preset = tarkovPreset, floorName, pinned, onClose, get, children }: {
  marker: MapMarker; filters: Filters; preset?: MarkerPreset; floorName?: string; /** Item lookup, when enrichment is ready: names, prices and value order. */ get?: ItemGet; pinned: boolean; onClose: () => void;
  /** Extra content at the bottom of the card (not for bosses). */ children?: ReactNode;
}) {
  const { icon: iconSrc, link: assetUrl } = useMapAssets();
  const [title, ...rest] = [marker.label, ...marker.tags].filter(Boolean) as string[];
  const { x, y, z } = marker.position;
  const place: Detail[] = [
    { label: "Position", value: `X ${x.toFixed(1)} · Z ${z.toFixed(1)} · Y ${y.toFixed(1)}` },
    ...floorName ? [{ label: "Floor", value: floorName }] : [],
  ];
  const close = pinned && <button type="button" className="icon-button" title="Close" onClick={onClose}><CloseIcon /></button>;
  if (marker.bosses) {
    const bosses = marker.bosses.filter((boss) => groupOn(filters[marker.layer], boss.group, marker.layer, preset));
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
        <Rows get={get} rows={[...boss.escorts.map((escort) => ({ label: "Escorts", value: `${escort.name} ${escort.count}` })),
          ...boss.spawnTime ? [{ label: "Spawn time", value: boss.spawnTime }] : [],
          ...boss.trigger ? [{ label: "Trigger", value: boss.trigger, mono: true }] : []]} />
      </div>)}
      <div className="marker-card">
        {!bosses.length && <div className="marker-card-head"><div className="marker-card-title"><span>{places}</span></div>{close}</div>}
        {bosses.length > 0 && <div className="marker-card-title"><span>{places}</span></div>}
        <Rows get={get} rows={place} />
      </div>
    </div>;
  }
  const document = marker.document;
  const photo = document && documentPhoto(document);
  // A known Battle Pass document location is just what it is: its name, photo and description.
  if (document) return <div className="marker-cards document"><div className="marker-card">
    <div className="marker-card-head"><div className="marker-card-title"><span>{document.title}</span></div>{close}</div>
    {photo && <img className="marker-card-photo" src={photo} alt={document.title} draggable={false} />}
    {document.description && <span className="marker-card-sub">{document.description}</span>}
    {children}
  </div></div>;
  return <div className="marker-cards"><div className="marker-card">
    <div className="marker-card-head">
      <img src={iconSrc(markerIcon(marker, filters, preset))} alt="" draggable={false} />
      <div className="marker-card-title"><span>{title}</span>{rest.length > 0 && <span className="marker-card-sub">{rest.join(" · ")}</span>}</div>
      {close}
    </div>
    <Rows get={get} rows={[...marker.details ?? [], ...place]} />
    {children}
  </div></div>;
}

const titleOf = (id: string, get?: ItemGet) => {
  const item = get?.(id), value = itemValue(item);
  return item ? (value ? `${item.name} · ${formatRoubles(value)}` : item.name) : id;
};

function Rows({ rows, get }: { rows: Detail[]; get?: ItemGet }) {
  const { icon: iconSrc } = useMapAssets();
  return rows.length > 0 ? <div className="marker-card-rows">
    {rows.map((row, index) => <div key={index} className="marker-card-row">
      <span className="marker-card-label">{row.label}</span>
      {row.items ? <div className="marker-card-items">
        {(get && row.items.length > 1 ? [...row.items].sort((a, b) => itemValue(get(b.id)) - itemValue(get(a.id))) : row.items).slice(0, MAX_ITEMS).map((item) => <span key={item.id} className="marker-card-item" title={titleOf(item.id, get)}>
          <img src={iconSrc(`item:${item.id}`)} alt={item.id} draggable={false} onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
          {(item.count ?? 1) > 1 && <span className="count">{item.count}</span>}
        </span>)}
        {get && row.items.length === 1 && <span>{get(row.items[0].id)?.name}</span>}
        {row.items.length > MAX_ITEMS && <span className="marker-card-label">+{row.items.length - MAX_ITEMS}</span>}
      </div> : <span className={row.mono ? "marker-card-id" : undefined}>{row.value}</span>}
    </div>)}
  </div> : null;
}
