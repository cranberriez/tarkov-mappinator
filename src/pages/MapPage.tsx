import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { Scanner } from "../lib/useScanner";
import { inCaptureOrder, positionsForRaid, toPlayerPosition } from "../lib/positions";
import type { RaidRecord } from "../lib/raids";
import type { PositionObservation } from "../bindings/PositionObservation";
import {
  artStyleOf, baseFloor, buildMarkers, countMarkers, defaultFilters, floorAt, floorById, floorsOf, games, httpMapSource, isVisible, layersFor,
  MapAssetsContext, mapName, maps as calibrations, resolveGame, resolveMap, roleOf, TarkovMap, useLookups, useMapData, withDefaults,
  type ArtStyle, type Filters, type FloorSelection, type PlayerPosition, type PlayerTrack, type Role, type TarkovMapHandle,
} from "../maps";
import { type DataMode, useDesktopMapSource } from "../tarkov-data";
import { bestLooseItems, useItemData } from "../lib/itemData";
import { MapLayersPanel } from "../components/MapLayersPanel";
import { MapMarkerCard } from "../components/MapMarkerCard";
import { appAssets } from "../lib/tiles";
import { keys, usePersisted } from "../lib/persist";
import { age } from "../lib/format";
import { useNow } from "../lib/useNow";
import { CrosshairIcon, LayersIcon, MinusIcon, PlusIcon, SplitIcon, TerrainIcon } from "../components/Icons";
import { MapSwitcher, type MapState } from "../components/MapSwitcher";
import { MapFloorPanel } from "../components/MapFloorPanel";
import { RaidScrubber } from "../components/RaidScrubber";
import type { GroupMember } from "../lib/group";

/** First letter of a name, for markers and the member list. */
const initial = (name: string) => name.charAt(0).toUpperCase();

/** A request to show a group member: their map, centred on them once. `nonce` makes a repeat click count. */
export type MemberFocus = { id: string; nonce: number };

/** Track id of this player's own positions. */
const SELF = "self";
/** Outside the desktop app there is no local mirror; map data comes straight from tarkov.dev. */
const webSource = isTauri() ? null : httpMapSource();

/**
 * The live raid's map, or with `viewing` a past raid's: its positions up to the one picked on the
 * scrubber, which then stands in for the newest position (followed, floor picked from it).
 */
export function MapPage({ scanner, viewing, onCloseViewing, mode, valuableLoot, members = [], focus = null }: {
  scanner: Scanner; viewing: RaidRecord | null; onCloseViewing: () => void; mode: DataMode; valuableLoot: boolean;
  /** Other group members; those with a position on the shown map are drawn there. */
  members?: GroupMember[];
  focus?: MemberFocus | null;
}) {
  const { snapshot, positions, connected, desktop } = scanner;
  const live = snapshot?.raid;
  const raid = viewing ? { map: viewing.map, game_mode: viewing.game_mode, player_role: null } : live;
  const raidId = viewing ? viewing.id : live && live.lifecycle !== "unknown" ? live.id : null;
  const track = useMemo(() => viewing ? inCaptureOrder(positionsForRaid(positions, viewing.id)) : null, [viewing, positions]);
  const [picked, setPicked] = useState<number | null>(null);
  const scrubIndex = track ? Math.min(picked ?? track.length - 1, track.length - 1) : -1;
  const raidMarkers = useMemo(() => track ? track.slice(0, scrubIndex + 1) : positionsForRaid(positions, raidId), [track, scrubIndex, positions, raidId]);

  // Following shows the raid's map; otherwise the map picked in the switcher (the raid's until one is picked).
  const [follow, setFollow] = useState(true);
  const [browsed, setBrowsed] = useState<string | null>(null);
  const shownMap = follow ? raid?.map : browsed ?? raid?.map;
  const shownKey = resolveGame(shownMap)?.key ?? null;
  const onRaidMap = !!raid?.map && shownKey === resolveGame(raid.map)?.key;
  // Positions are in the raid map's coordinates, so they only show on that map.
  const markers = onRaidMap ? raidMarkers : [];
  const newest: PositionObservation | undefined = markers[markers.length - 1];
  // Group members on the shown map: their newest position only, in their colour. Not over a past raid.
  const peers = useMemo((): PlayerTrack[] => viewing ? [] : members
    .filter((member) => member.position && member.map && resolveGame(member.map)?.key === shownKey)
    .map((member) => ({ id: `peer:${member.id}`, label: member.name, color: member.color, className: "peer", badge: initial(member.name), positions: [member.position!] })),
  [members, viewing, shownKey]);
  // This player first: with nothing followed, the map opens on the first track. Peers' markers sit below (styles).
  const players = useMemo((): PlayerTrack[] => [
    ...(markers.length ? [{ id: SELF, live: !viewing, positions: markers.map(toPlayerPosition) }] : []), ...peers,
  ], [markers, viewing, peers]);

  const calibration = resolveMap(shownMap);
  const map = useRef<TarkovMapHandle>(null);
  // Vector art by default; tiles when chosen or when the map has no vector art.
  const [preferred, setPreferred] = usePersisted<ArtStyle>(keys.mapStyle, "svg");
  const style = artStyleOf(calibration, preferred);
  const [splitOn, setSplitOn] = usePersisted(keys.mapSplit, false);
  const split = splitOn && style !== null;

  // Overlay markers for the shown map and mode; filters are remembered per player role.
  const desktopSource = useDesktopMapSource();
  const source = webSource ?? desktopSource;
  const mapData = useMapData(source, shownKey, mode);
  const lookups = useLookups(source, mode);
  const overlay = useMemo(() => mapData ? buildMarkers(mapData, lookups) : [], [mapData, lookups]);
  const itemData = useItemData(mode);
  const getItem = itemData.ok ? itemData.get : undefined;
  const lootIcons = useMemo(() => valuableLoot && getItem ? bestLooseItems(overlay, getItem) : undefined, [valuableLoot, getItem, overlay]);
  const overlayById = useMemo(() => new Map(overlay.map((marker) => [marker.id, marker])), [overlay]);
  // Hovering previews a marker's detail card; clicking pins it until closed (X, Escape, clicking it again) or another is clicked.
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  useEffect(() => { setHovered(null); setPinned(null); }, [mapData]);
  useEffect(() => {
    if (!pinned) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPinned(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned]);
  const cardMarker = overlayById.get(pinned ?? hovered ?? "");
  const counts = useMemo(() => countMarkers(overlay), [overlay]);
  const layerDefs = useMemo(() => layersFor(overlay, mapData?.looseCategories), [overlay, mapData]);
  const role = roleOf(raid?.player_role);
  const [storedFilters, setStoredFilters] = usePersisted<Partial<Record<Role, Filters>>>(keys.mapLayers, {});
  const filters = useMemo(() => withDefaults(storedFilters[role], role), [storedFilters, role]);
  const [layersOpen, setLayersOpen] = usePersisted(keys.mapLayersOpen, true);
  const [collapsed, setCollapsed] = usePersisted<Record<string, boolean>>(keys.mapLayersCollapsed, {});
  const [presets, setPresets] = usePersisted<(Filters | null)[]>(keys.mapPresets, []);
  const shownOverlay = useMemo(() => overlay.filter((marker) => isVisible(marker, filters)), [overlay, filters]);

  // Floors: following picks the player's floor (all floors until there is a position); otherwise the
  // chosen floor, or all floors (null). Art draws the shown floor over the base; markers elsewhere hide, extracts elsewhere dim.
  const floors = calibration?.layers.length ? floorsOf(calibration) : [];
  const [chosenFloor, setChosenFloor] = useState<FloorSelection>(null);
  useEffect(() => setChosenFloor(null), [calibration]);
  const followedFloor = calibration && newest ? floorAt(calibration, toPlayerPosition(newest)).id : null;
  // A pinned marker shows its own floor until unpinned, then the floor from before (chosen, all, or followed) returns.
  const [pinFloor, setPinFloor] = useState<string | undefined>(undefined);
  useEffect(() => {
    const marker = pinned ? overlayById.get(pinned) : undefined;
    setPinFloor(pinned && calibration && floors.length ? (marker ? floorAt(calibration, marker.position) : baseFloor(calibration)).id : undefined);
  }, [pinned]);
  const wanted = pinFloor ?? (follow ? followedFloor : chosenFloor);
  // A floor of the map before a switch means nothing here.
  const shownFloor = calibration ? floorById(calibration, wanted) : null;
  const floor: FloorSelection = shownFloor?.id ?? null;
  const [floorsOpen, setFloorsOpen] = usePersisted(keys.mapFloorsOpen, false);
  /** Picking a floor takes over from following and from a pinned marker's floor; while split, it goes to the floor's column. */
  const chooseFloor = (id: FloorSelection) => {
    leaveFollow();
    setPinFloor(undefined);
    if (split) map.current?.focusFloor(id);
    else setChosenFloor(id);
  };
  /** Turning follow off by hand goes back to all floors. */
  const toggleFollow = () => { if (follow) { setChosenFloor(null); leaveFollow(); } else { setFollow(true); setCentre(null); } };
  /** Stops following, staying on the map being shown. */
  function leaveFollow() { setBrowsed(shownMap ?? null); setFollow(false); }
  /** Panning stops following but keeps the floor it was showing. */
  const onUserPan = () => { if (follow) { setChosenFloor(followedFloor); leaveFollow(); } };
  const chooseMap = (key: string) => { setBrowsed(key); setFollow(false); setCentre(null); };

  // Jumping to a member shows their map and centres on them once; following stays with this player.
  const [centre, setCentre] = useState<{ key: string; map: string; point: PlayerPosition } | null>(null);
  const showMember = (member: GroupMember | undefined, nonce: number) => {
    const key = member?.map ? resolveGame(member.map)?.key : null;
    if (!member || !key) return;
    if (viewing) onCloseViewing();
    setBrowsed(key);
    setFollow(false);
    setChosenFloor(null);
    setCentre(member.position ? { key: `${member.id}|${nonce}`, map: key, point: member.position } : null);
  };
  useEffect(() => { if (focus) showMember(members.find((other) => other.id === focus.id), focus.nonce); }, [focus?.nonce]);
  const mapOptions = useMemo(() => games.filter((game) => game.art && calibrations[game.art])
    .map((game) => ({ key: game.key, label: game.name })), []);

  const status = !desktop ? "preview" : connected ? "online" : "offline";
  const liveRaid = scanner.running && live?.lifecycle === "active";
  // Members in a raid on this player's live raid map (maybe not the same raid; nothing says which).
  const liveKey = liveRaid ? resolveGame(live.map)?.key ?? null : null;
  const mapmates = liveKey ? members.filter((member) => member.status === "in-raid" && member.map && resolveGame(member.map)?.key === liveKey) : [];
  const mapState: MapState = status === "offline" ? "offline" : liveRaid && (viewing || shownKey !== (resolveGame(live.map)?.key ?? null)) ? "elsewhere" : liveRaid ? "live" : "idle";

  return <MapAssetsContext.Provider value={appAssets}><div className="map-page">
    <TarkovMap ref={map} map={calibration} art={preferred} floor={floor} split={split} players={players} follow={follow ? SELF : null}
      centre={centre && centre.map === shownKey ? centre : null}
      onUserPan={onUserPan} markers={shownOverlay} filters={filters} lootIcons={lootIcons} selected={pinned}
      onMarkerHover={setHovered} onMarkerTap={(id) => setPinned((current) => current === id ? null : id)}>
      {!newest && (onRaidMap || !calibration) && <p className={`map-empty ${calibration ? "on-map" : ""}`}>Take a screenshot in raid to place a position</p>}
    </TarkovMap>

    <div className="map-left">
      <MapLayersPanel layers={layerDefs} filters={filters} defaults={defaultFilters(role)} counts={counts} open={layersOpen} onOpen={setLayersOpen}
        onChange={(next) => setStoredFilters((current) => ({ ...current, [role]: next }))}
        collapsed={collapsed} onCollapse={setCollapsed} presets={presets} onPresets={setPresets} />
      <div className="map-left-bottom">
        {floors.length > 0 && <MapFloorPanel floors={floors.map((option) => ({ key: option.id, label: option.name }))} current={split ? null : floor}
          following={follow} open={floorsOpen} onOpen={setFloorsOpen} onSelect={chooseFloor} />}
        <div className="map-bottom-row">
          <div className="map-tools">
            <button type="button" className={`icon-button ${follow ? "active" : ""}`} aria-pressed={follow}
              title={viewing ? "Follow selected position" : "Follow newest position"} onClick={toggleFollow}><CrosshairIcon /></button>
            <button type="button" className={`icon-button ${floorsOpen && floors.length ? "active" : ""}`} aria-pressed={floorsOpen}
              disabled={!floors.length} title={floors.length ? (floorsOpen ? "Hide floors" : "Show floors") : "This map has one floor"}
              onClick={() => setFloorsOpen(!floorsOpen)}><LayersIcon /></button>
            <button type="button" className={`icon-button ${split ? "active" : ""}`} aria-pressed={split}
              disabled={style === null || floors.length === 0}
              title={floors.length === 0 ? "This map has one floor" : split ? "Stack floors" : "Split floors apart"}
              onClick={() => setSplitOn(!splitOn)}><SplitIcon /></button>
            <button type="button" className={`icon-button ${style === "tiles" ? "active" : ""}`} aria-pressed={style === "tiles"}
              disabled={!(calibration?.svg && calibration.tilePath)}
              title={!(calibration?.svg && calibration.tilePath) ? "Only one map style for this map" : style === "tiles" ? "Show vector map" : "Show detailed tiles"}
              onClick={() => setPreferred(style === "tiles" ? "svg" : "tiles")}><TerrainIcon /></button>
            <button type="button" className="icon-button" title="Zoom in" onClick={() => map.current?.zoomBy(1.5)}><PlusIcon /></button>
            <button type="button" className="icon-button" title="Zoom out" onClick={() => map.current?.zoomBy(1 / 1.5)}><MinusIcon /></button>
            {newest && <Readout position={newest} ageShown={!viewing} />}
          </div>
          {viewing && track && track.length > 0 && <RaidScrubber raid={viewing} positions={track} index={scrubIndex}
            onSelect={setPicked} onClose={onCloseViewing} />}
        </div>
      </div>
    </div>

    {cardMarker && <MapMarkerCard marker={cardMarker} filters={filters} get={getItem} pinned={!!pinned} onClose={() => setPinned(null)}
      floorName={calibration && floors.length ? floorAt(calibration, cardMarker.position).name : undefined} />}

    <MapSwitcher maps={mapOptions} current={shownKey} label={mapName(shownMap) ?? (status === "online" ? "No map" : status === "offline" ? "Disconnected" : "Preview")}
      floor={shownFloor && !shownFloor.base ? shownFloor.name : undefined} state={mapState} liveName={mapName(live?.map)} onSelect={chooseMap}
      onSwitch={() => { if (viewing) onCloseViewing(); setFollow(true); setCentre(null); }}>
      {mapmates.length > 0 && <ul className="mapmates" aria-label="Group members on this map">
        {mapmates.map((member) => <li key={member.id}>
          <button type="button" className="mapmate" disabled={!member.position} title={member.position ? "Show on map" : "No position yet"}
            onClick={() => showMember(member, Date.now())}>
            <span className="mapmate-icon" style={{ "--player": member.color } as CSSProperties}><span>{initial(member.name)}</span></span>{member.name}
          </button>
        </li>)}
      </ul>}
    </MapSwitcher>
  </div></MapAssetsContext.Provider>;
}

/** The newest position's coordinates, and its age while live; ticks on its own so the map doesn't re-render. */
function Readout({ position, ageShown }: { position: PositionObservation; ageShown: boolean }) {
  const now = useNow(500);
  return <span className="map-readout">
    <span>X {position.xyz[0].toFixed(1)}</span><span>Z {position.xyz[2].toFixed(1)}</span>
    {ageShown && <span className="faint">{age(position.observed_at, now)} ago</span>}
  </span>;
}
