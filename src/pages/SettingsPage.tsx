import { useEffect, useRef, useState } from "react";
import type { Scanner } from "../lib/useScanner";
import type { MiniMode } from "../lib/useMiniMode";
import type { FolderConfig } from "../bindings/FolderConfig";
import type { SourceHealth } from "../bindings/SourceHealth";
import { LogCoveragePanel } from "../components/LogCoveragePanel";
import { syncData, useDataStatus } from "../tarkov-data";
import { clearItemData, configureItemData, syncItemData, useItemStatus, type ItemConfig, type ItemStatus } from "../lib/itemData";
import { age } from "../lib/format";
import { games, maps, tileCount, type MapCalibration } from "../maps";
import {
  cancelPrefetch, clearTileCache, getCacheStats, getCoverage, getPrefetchStatus, onPrefetch, prefetchTiles, tileJobs,
  type CacheStats, type PrefetchStatus,
} from "../lib/tiles";
import { isTauri } from "../lib/scanner";
import type { CompanionConnection } from "../lib/useCompanion";
import { connectionLabel, connectionTone } from "../lib/companion";
import { ClientList, connectionDetail, PendingPrompts } from "../components/ConnectionPanel";
import { useNow } from "../lib/useNow";
import type { AutoShot } from "../lib/useAutoShot";
import type { ShotCleanup } from "../lib/useShotCleanup";
import { toastModes, type ToastModeState } from "../lib/useToastMode";
import type { ValuableLootState } from "../lib/useValuableLoot";
import { DEFAULT_GROUP_SITE, type Group } from "../lib/useGroup";
import { normalizeSite } from "../lib/group";
import type { AutoShotState } from "../bindings/AutoShotState";
import {
  clearAllData, getCleanupPlan, getHistoryStats, onHistoryReset, onHistoryUpdated, resetPreferences, runCleanup,
  type CleanupKind, type CleanupPlan, type HistoryStats,
} from "../lib/history";

const statusLabel: Record<SourceHealth["status"], string> = {
  not_configured: "Not set", available: "Accessible", missing: "Missing", not_directory: "Not a folder", unreadable: "No access",
};

function FolderField({ id, label, value, health, disabled, placeholder, onChange }: {
  id: string; label: string; value: string; health?: SourceHealth; disabled: boolean; placeholder: string;
  onChange: (value: string) => void;
}) {
  const ok = health?.status === "available";
  return <div className="field">
    <div className="field-label">
      <label htmlFor={id}>{label}</label>
      <span className={`status ${ok ? "ok" : health && health.status !== "not_configured" ? "bad" : ""}`}>
        <span className="dot" />{health ? statusLabel[health.status] : "Unknown"}</span>
    </div>
    <input id={id} value={value} placeholder={placeholder} spellCheck={false} disabled={disabled}
      onChange={(event) => onChange(event.target.value)} />
    {health && !ok && <p className="faint">{health.detail}</p>}
  </div>;
}

function Switch({ label, detail, on, disabled, onChange }: {
  label: string; detail: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void;
}) {
  return <button type="button" role="switch" aria-checked={on} className="switch-row" disabled={disabled}
    onClick={() => onChange(!on)}>
    <span><strong>{label}</strong><span className="faint">{detail}</span></span>
    <span className={`switch ${on ? "on" : ""}`} aria-hidden="true" />
  </button>;
}

export function SettingsPage({ scanner, mini, connection, autoShot, shotCleanup, toastMode, valuableLoot, group }: {
  scanner: Scanner; mini: MiniMode; connection: CompanionConnection; autoShot: AutoShot; shotCleanup: ShotCleanup; toastMode: ToastModeState; valuableLoot: ValuableLootState;
  group: Group;
}) {
  const { snapshot, running, connected, busy, error, perform, retry } = scanner;
  const [folders, setFolders] = useState<FolderConfig>({ screenshots: "", logs: "" });
  const edited = useRef(false);
  useEffect(() => { if (snapshot && !edited.current) setFolders(snapshot.config); }, [snapshot]);
  const locked = !connected || !!busy || running;
  const itemStatus = useItemStatus();
  const update = (patch: Partial<FolderConfig>) => { edited.current = true; setFolders((current) => ({ ...current, ...patch })); };

  return <div className="page">
    <header className="page-header"><h1>Settings</h1></header>
    {error && <div className="error" role="alert">{error}
      {!connected && <button type="button" className="link" onClick={retry}>Retry</button>}</div>}

    <section className="settings-section">
      <h2>Mini mode</h2>
      <Switch label="Mini mode" detail="Shrink to a small strip with start, stop and close." on={mini.mini}
        disabled={!mini.desktop} onChange={mini.setMini} />
      <Switch label="Start in mini mode" detail="Open the app as the strip next time." on={mini.startMini}
        disabled={!mini.desktop} onChange={mini.setStartMini} />
    </section>

    <section className="settings-section">
      <h2>Notifications</h2>
      <div className="action-row">
        <span><strong>Notifications</strong><span className="faint">Pop-ups for live activity.</span></span>
        <div className="segmented" role="group" aria-label="Notifications">
          {toastModes.map((option) => <button key={option.value} type="button" className={toastMode.mode === option.value ? "selected" : ""}
            aria-pressed={toastMode.mode === option.value} onClick={() => toastMode.setMode(option.value)}>{option.label}</button>)}
        </div>
      </div>
    </section>

    <section className="settings-section">
      <h2>Map</h2>
      <Switch label="Valuable loot icons" detail={itemStatus?.config.enabled ? "Experimental. Loose loot shows its most valuable possible item." : "Needs item enrichment (Item data below)."}
        on={valuableLoot.on} disabled={!itemStatus?.config.enabled} onChange={valuableLoot.setOn} />
    </section>

    <ConnectionSection connection={connection} />
    <GroupServerSection group={group} />
    <AutoShotSection autoShot={autoShot} />

    <section className="settings-section">
      <h2>Sources</h2>
      <form onSubmit={(event) => { event.preventDefault(); edited.current = false; void perform("check", folders); }}>
        <FolderField id="screenshots" label="Screenshots" value={folders.screenshots} health={snapshot?.screenshots}
          disabled={locked} placeholder="Absolute path to the screenshot folder" onChange={(screenshots) => update({ screenshots })} />
        <FolderField id="logs" label="Game logs" value={folders.logs} health={snapshot?.logs}
          disabled={locked} placeholder="Tarkov installation Logs folder" onChange={(logs) => update({ logs })} />
        <div className="form-actions">
          <button type="submit" className="secondary" disabled={locked}>{busy === "check" ? "Checking…" : "Check folders"}</button>
          {running && <span className="faint">Stop monitoring to edit.</span>}
        </div>
      </form>
    </section>

    <section className="settings-section">
      <h2>Scanner health</h2>
      <div className="stats compact">
        <div className="stat"><span>Screenshots seen</span><strong>{snapshot?.screenshots_seen ?? "—"}</strong></div>
        <div className="stat"><span>Rejected</span><strong>{snapshot?.screenshots_rejected ?? "—"}</strong></div>
        <div className="stat"><span>Revision</span><strong>{snapshot?.revision ?? "—"}</strong></div>
      </div>
      {snapshot?.diagnostics.length
        ? <ul className="diagnostics">{snapshot.diagnostics.map((detail, index) => <li key={index}>{detail}</li>)}</ul>
        : <p className="faint">{snapshot ? "No issues reported." : "Backend not connected."}</p>}
    </section>

    <StoredDataSection shotCleanup={shotCleanup} />
    <MapDataSection />
    <ItemDataSection status={itemStatus} />
    <TileSection />

    <section className="settings-section">
      <h2>Log coverage</h2>
      <LogCoveragePanel snapshot={snapshot} />
    </section>

    <DangerZone />
  </div>;
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** A two-click button: the first click asks, the second acts; leaving it cancels. */
function ConfirmButton({ label, confirm, busy, disabled, onConfirm }: {
  label: string; confirm: string; busy?: string | null; disabled?: boolean; onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  return <button type="button" className={`secondary ${asking ? "danger" : ""}`} disabled={disabled || !!busy}
    onBlur={() => setAsking(false)} onClick={() => { if (asking) { setAsking(false); onConfirm(); } else setAsking(true); }}>
    {busy ?? (asking ? confirm : label)}</button>;
}

function StoredDataSection({ shotCleanup }: { shotCleanup: ShotCleanup }) {
  const desktop = isTauri();
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [busy, setBusy] = useState<CleanupKind | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    getHistoryStats().then(setStats, (cause) => setError(String(cause)));
    getCleanupPlan().then(setPlan, (cause) => setError(String(cause)));
  };
  useEffect(() => {
    if (!desktop) return;
    refresh();
    const updated = onHistoryUpdated(() => getHistoryStats().then(setStats, () => {}));
    const reset = onHistoryReset(refresh);
    return () => { void updated.then((stop) => stop()); void reset.then((stop) => stop()); };
  }, []);

  const clean = (kind: CleanupKind) => {
    setBusy(kind);
    setError(null);
    setNote(null);
    runCleanup(kind).then((moved) => setNote(`Moved ${plural(moved, kind === "logs" ? "log session" : "screenshot")} to the Recycle Bin.`),
      (cause) => setError(String(cause))).finally(() => { setBusy(null); refresh(); });
  };
  const ago = (value: string | null | undefined) => value ? `${age(value, Date.now())} ago` : "Never";

  return <section className="settings-section">
    <h2>Stored data</h2>
    {stats?.error && <p className="diagnostics">{stats.error}</p>}
    <div className="stats compact">
      <div className="stat"><span>Raids</span><strong>{stats?.raids.toLocaleString() ?? "—"}</strong></div>
      <div className="stat"><span>Positions</span><strong>{stats?.positions.toLocaleString() ?? "—"}</strong></div>
      <div className="stat"><span>Events</span><strong>{stats?.activity.toLocaleString() ?? "—"}</strong></div>
      <div className="stat"><span>On disk</span><strong>{stats ? megabytes(stats.bytes) : "—"}</strong></div>
      <div className="stat"><span>Last import</span><strong>{stats ? ago(stats.last_import_at) : "—"}</strong></div>
    </div>
    {!desktop && <p className="faint">Desktop app only.</p>}
    <Switch label="Delete raid screenshots" detail="When a raid ends, permanently delete its screenshots. Positions stay stored."
      on={shotCleanup.deleteAfterRaid} disabled={!desktop} onChange={shotCleanup.setDeleteAfterRaid} />
    {shotCleanup.error && <p className="diagnostics">{shotCleanup.error}</p>}
    {plan && <>
      <div className="action-row">
        <span><strong>Imported screenshots</strong>
          <span className="faint">{plan.screenshots ? `${plural(plan.screenshots, "file")} · ${megabytes(plan.screenshot_bytes)}, positions already stored` : "None to remove."}</span></span>
        <ConfirmButton label="Move to Recycle Bin" confirm={`Move ${plural(plan.screenshots, "file")}?`} disabled={!plan.screenshots}
          busy={busy === "screenshots" ? "Moving…" : null} onConfirm={() => clean("screenshots")} />
      </div>
      <div className="action-row">
        <span><strong>Imported log sessions</strong>
          <span className="faint">{plan.log_sessions ? `${plural(plan.log_sessions, "session")} · ${megabytes(plan.log_bytes)}, newest always kept` : "None to remove. The newest session is always kept."}</span></span>
        <ConfirmButton label="Move to Recycle Bin" confirm={`Move ${plural(plan.log_sessions, "session")}?`} disabled={!plan.log_sessions}
          busy={busy === "logs" ? "Moving…" : null} onConfirm={() => clean("logs")} />
      </div>
    </>}
    {note && <p className="faint section-note">{note}</p>}
    {error && <p className="diagnostics">{error}</p>}
  </section>;
}

/** Which site signs group channels: the default, or a local/dev site while testing. */
function GroupServerSection({ group }: { group: Group }) {
  const [typed, setTyped] = useState(group.siteOverride);
  useEffect(() => setTyped(group.siteOverride), [group.siteOverride]);
  const site = normalizeSite(typed);
  const invalid = !!typed.trim() && !site;
  const changed = (site ?? "") !== (normalizeSite(group.siteOverride) ?? "");
  return <section className="settings-section">
    <h2>Group</h2>
    <form onSubmit={(event) => { event.preventDefault(); if (!invalid) group.setSiteOverride(site ?? ""); }}>
      <div className="field">
        <div className="field-label"><label htmlFor="group-site">Server</label><span className="faint">In use: {group.site}</span></div>
        <input id="group-site" value={typed} placeholder={DEFAULT_GROUP_SITE} spellCheck={false} autoComplete="off"
          onChange={(event) => setTyped(event.target.value)} />
        <p className="faint">{invalid ? "Not a web address." : "Site that signs groups, e.g. http://localhost:3000. Empty uses the default."}</p>
      </div>
      <div className="form-actions">
        <button type="submit" className="secondary" disabled={invalid || !changed}>Save</button>
        {group.siteOverride && <button type="button" className="link" onClick={() => group.setSiteOverride("")}>Use default</button>}
      </div>
    </form>
  </section>;
}

function DangerZone() {
  const desktop = isTauri();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    action().catch((cause) => setError(String(cause))).finally(() => setBusy(null));
  };
  return <section className="settings-section danger-zone">
    <h2>Danger zone</h2>
    <div className="action-row">
      <span><strong>Delete all stored data</strong>
        <span className="faint">Raids, positions, events, import record, map tiles, map data and paired sites. Game files are not touched.</span></span>
      <ConfirmButton label="Delete data" confirm="Delete everything?" disabled={!desktop} busy={busy === "data" ? "Deleting…" : null}
        onConfirm={() => act("data", () => clearAllData().then(() => window.location.reload()))} />
    </div>
    <div className="action-row">
      <span><strong>Reset preferences</strong>
        <span className="faint">Window, map, mini mode, connection and auto-screenshot settings. Reloads the app.</span></span>
      <ConfirmButton label="Reset" confirm="Reset preferences?" busy={busy === "prefs" ? "Resetting…" : null}
        onConfirm={() => act("prefs", resetPreferences)} />
    </div>
    {error && <p className="diagnostics">{error}</p>}
  </section>;
}

function ConnectionSection({ connection }: { connection: CompanionConnection }) {
  const now = useNow();
  const kind = connection.connection;
  const detail = connectionDetail(connection);
  return <section className="settings-section">
    <h2>Site connection</h2>
    <Switch label="Connect to Tarkov Hideout"
      detail="Lets tarkovhideout.com, in a browser on this PC, read your quest accepts, completions and failures, your current raid (map, mode, phase), your latest screenshot position and this connection's status. Sites must be allowed here first; nothing else is shared."
      on={connection.enabled} disabled={!connection.desktop} onChange={connection.setEnabled} />
    {connection.enabled && <div className="connection-settings">
      <div className="row">
        <span className={`status ${kind === "error" ? "bad" : ""}`}><span className={`dot ${connectionTone[kind]}`} />{connectionLabel[kind]}</span>
        {connection.status?.port && <span className="faint">Port {connection.status.port}</span>}
        {detail && <span className={kind === "error" ? "bad-text" : "faint"}>{detail}</span>}
        {kind === "error" && <button type="button" className="link" onClick={() => void connection.retry()}>Retry</button>}
      </div>
      <PendingPrompts connection={connection} />
    </div>}
    {connection.error && <p className="diagnostics">{connection.error}</p>}
    {(connection.enabled || !!connection.status?.clients.length || !!connection.status?.revoked.length) && <ClientList connection={connection} now={now} revoked="all" />}
  </section>;
}

function MapDataSection() {
  const status = useDataStatus();
  const manifest = status?.manifest;
  const syncing = status?.state === "syncing";
  const ago = (value: string | undefined) => value ? `${age(value, Date.now())} ago` : "—";
  return <section className="settings-section">
    <h2>Map data</h2>
    <div className="stats compact">
      <div className="stat"><span>Maps</span><strong>{manifest?.maps.length ?? "—"}</strong></div>
      <div className="stat"><span>Downloaded</span><strong>{ago(manifest?.fetched_at)}</strong></div>
      <div className="stat"><span>Checked</span><strong>{syncing ? "Checking…" : ago(manifest?.checked_at)}</strong></div>
    </div>
    {status?.state === "failed" && <p className="faint">{status.error}</p>}
    <div className="form-actions">
      <button type="button" className="secondary" disabled={!status || syncing} onClick={() => void syncData()}>
        {syncing ? "Syncing…" : "Check now"}</button>
      <span className="faint">From tarkov.dev, checked every 6 hours.</span>
    </div>
  </section>;
}

const itemPieces: { key: keyof ItemConfig["pieces"]; label: string }[] = [
  { key: "flea", label: "Flea prices" }, { key: "traders", label: "Trader prices" },
  { key: "stats", label: "Stats & properties" }, { key: "extra", label: "Categories, contents & links" },
];

function ItemDataSection({ status }: { status: ItemStatus | null }) {
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const config = status?.config, enabled = !!config?.enabled, syncing = status?.state === "syncing";
  const ago = (value: string | null | undefined) => value ? `${age(value, Date.now())} ago` : "—";
  const configure = (next: ItemConfig) => { setError(null); configureItemData(next).catch((cause) => setError(String(cause))); };
  return <section className="settings-section">
    <h2>Item data</h2>
    <Switch label="Item enrichment" detail="Item names and prices from tarkov.dev, used for item details on the map. Nothing is downloaded while off."
      on={enabled} disabled={!status} onChange={(on) => config && configure({ ...config, enabled: on })} />
    {config && enabled && <>
      {itemPieces.map(({ key, label }) => <Switch key={key} label={label} detail="" on={config.pieces[key]}
        onChange={(on) => configure({ ...config, pieces: { ...config.pieces, [key]: on } })} />)}
      <p className="faint section-note">Switching a piece off removes it from disk; switching it on downloads it.</p>
    </>}
    {status && (enabled || status.fetched_at) && <div className="stats compact">
      <div className="stat"><span>Items</span><strong>{status.fetched_at ? status.items.toLocaleString() : "—"}</strong></div>
      <div className="stat"><span>Downloaded</span><strong>{ago(status.fetched_at)}</strong></div>
      <div className="stat"><span>Checked</span><strong>{syncing ? "Checking…" : ago(status.checked_at)}</strong></div>
      <div className="stat"><span>Storage</span><strong>{status.fetched_at ? megabytes(status.bytes) : "—"}</strong></div>
    </div>}
    {!enabled && status?.fetched_at && <p className="faint">Kept on disk, not used or updated.</p>}
    {status?.state === "failed" && <p className="faint">{status.error}</p>}
    {error && <p className="diagnostics">{error}</p>}
    {status && (enabled || status.fetched_at) && <div className="form-actions">
      {enabled && <button type="button" className="secondary" disabled={syncing} onClick={() => void syncItemData()}>
        {syncing ? "Syncing…" : "Check now"}</button>}
      <ConfirmButton label="Remove" confirm="Remove item data?" disabled={!status.fetched_at} busy={clearing ? "Removing…" : null}
        onConfirm={() => { setClearing(true); setError(null); clearItemData().catch((cause) => setError(String(cause))).finally(() => setClearing(false)); }} />
    </div>}
  </section>;
}

const tiled = Object.values(maps).filter((map) => map.tilePath);
const artName = (map: MapCalibration) => games.find((game) => game.art === map.key)?.name ?? map.key;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

function TileSection() {
  const desktop = isTauri();
  const [prefetch, setPrefetch] = useState<PrefetchStatus | null>(null);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [coverage, setCoverage] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const running = !!prefetch?.running;

  const refresh = () => {
    getCacheStats().then(setStats, () => {});
    for (const map of tiled) getCoverage(map).then((count) => setCoverage((current) => ({ ...current, [map.key]: count })), () => {});
  };
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    getPrefetchStatus().then((status) => { if (live) setPrefetch(status); }, () => {});
    const stop = onPrefetch((status) => {
      if (!live) return;
      setPrefetch(status);
      if (!status.running) refresh();
    });
    refresh();
    return () => { live = false; void stop.then((unlisten) => unlisten()); };
  }, []);

  const act = (action: Promise<unknown>) => { setError(null); action.then(refresh, (reason) => setError(String(reason))); };

  return <section className="settings-section">
    <h2>Map tiles</h2>
    <p className="faint section-note">Detailed tiles load from tarkov.dev as you view them and are kept on disk.
      Download a map to use it offline.</p>
    {error && <p className="diagnostics">{error}</p>}
    <div className="table-scroll"><table className="table">
      <thead><tr><th>Map</th><th className="num">Cached</th><th className="num">Tiles</th><th /></tr></thead>
      <tbody>{tiled.map((map) => {
        const total = tileCount(map), have = coverage[map.key];
        const active = running && prefetch?.label === map.key;
        return <tr key={map.key}>
          <td>{artName(map)}</td>
          <td className="num">{active ? `${Math.round(prefetch.done / prefetch.total * 100)}%`
            : have === undefined ? "—" : `${Math.floor(have / total * 100)}%`}</td>
          <td className="num">{total.toLocaleString()}</td>
          <td className="num">{active
            ? <button type="button" className="link" onClick={() => void cancelPrefetch()}>Stop</button>
            : <button type="button" className="link" disabled={!desktop || running || have === total}
              onClick={() => act(prefetchTiles(map.key, tileJobs(map)))}>{have === total ? "Done" : "Download"}</button>}</td>
        </tr>;
      })}</tbody>
    </table></div>
    {prefetch && !prefetch.running && prefetch.label && <p className="faint section-note">
      {prefetch.cancelled ? "Stopped" : "Finished"} {artName(maps[prefetch.label] ?? { key: prefetch.label } as MapCalibration)}:
      {" "}{prefetch.downloaded.toLocaleString()} downloaded{prefetch.failed ? `, ${prefetch.failed.toLocaleString()} failed` : ""}.</p>}
    <div className="form-actions">
      <span className="faint">{stats ? `${megabytes(stats.bytes)} on disk` : desktop ? "—" : "Desktop app only."}</span>
      <button type="button" className="secondary" disabled={!desktop || running || !stats?.files}
        onClick={() => act(clearTileCache())}>Clear tiles</button>
    </div>
  </section>;
}

const shotLabel: Record<AutoShotState, string> = { off: "Off", waiting: "Waiting", armed: "Capturing", error: "Error" };
const shotTone: Record<AutoShotState, string> = { off: "", waiting: "warn", armed: "ok", error: "bad" };
/** `KeyboardEvent.code` as printed on the key. */
const keyName = (code: string) => code.replace(/^Key|^Digit/, "").replace("PrintScreen", "Print Screen");

function KeyCapture({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (code: string) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    // Windows swallows Print Screen's keydown, so keyup is accepted too.
    const take = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.code !== "Escape") onChange(event.code);
      setListening(false);
    };
    window.addEventListener("keydown", take);
    window.addEventListener("keyup", take);
    return () => { window.removeEventListener("keydown", take); window.removeEventListener("keyup", take); };
  }, [listening, onChange]);
  return <button type="button" className="secondary key-capture" disabled={disabled} onClick={() => setListening(true)}>
    {listening ? "Press a key…" : keyName(value)}</button>;
}

function AutoShotSection({ autoShot }: { autoShot: AutoShot }) {
  const { desktop, config, status, error, setConfig } = autoShot;
  const now = useNow();
  const state = status?.state ?? "off";
  const next = status?.next_at ? Math.max(0, Math.ceil((Date.parse(status.next_at) - now) / 1000)) : null;
  // Turning on takes a second, explicit click past the risk warning.
  const [confirming, setConfirming] = useState(false);
  return <section className="settings-section">
    <h2>Auto-screenshot <span className="experimental">Experimental</span></h2>
    <p className="warn-text section-note">Risks a ban. Sends key presses that Windows marks as injected, and Tarkov's terms
      prohibit automated scripts acting on the game.</p>
    <Switch label="Auto-screenshot" detail="Presses your in-game screenshot key every 5–15s, at random, during raids while the game is in front."
      on={config.enabled || confirming} disabled={!desktop}
      onChange={(enabled) => enabled ? setConfirming(true) : (setConfirming(false), setConfig({ enabled: false }))} />
    {confirming && <div className="form-actions">
      <button type="button" className="secondary danger" onClick={() => { setConfirming(false); setConfig({ enabled: true }); }}>Turn on anyway</button>
      <button type="button" className="link" onClick={() => setConfirming(false)}>Cancel</button>
    </div>}
    {config.enabled && <div className="connection-settings">
      <div className="row autoshot-row">
        <KeyCapture value={config.key} disabled={!desktop} onChange={(key) => setConfig({ key })} />
      </div>
      <div className="row">
        <span className={`status ${state === "error" ? "bad" : ""}`}><span className={`dot ${shotTone[state]}`} />{shotLabel[state]}</span>
        <span className={state === "error" ? "bad-text" : "faint"}>{state === "armed" && next !== null ? `Next in ${next}s` : status?.detail}</span>
        {!!status?.presses && <span className="faint">{status.presses} taken</span>}
      </div>
    </div>}
    {config.enabled && <Switch label="Delete after reading" detail="Removes screenshots taken by this, once their position is read."
      on={config.delete_after} disabled={!desktop} onChange={(delete_after) => setConfig({ delete_after })} />}
    {error && <p className="diagnostics">{error}</p>}
  </section>;
}
