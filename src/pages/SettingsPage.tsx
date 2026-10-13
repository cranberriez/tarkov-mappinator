import { useEffect, useRef, useState } from "react";
import type { Scanner } from "../lib/useScanner";
import type { MiniMode } from "../lib/useMiniMode";
import type { FolderConfig } from "../bindings/FolderConfig";
import type { SourceHealth } from "../bindings/SourceHealth";
import { LogCoveragePanel } from "../components/LogCoveragePanel";
import { syncData, useDataStatus } from "../tarkov-data";
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

export function SettingsPage({ scanner, mini, connection }: { scanner: Scanner; mini: MiniMode; connection: CompanionConnection }) {
  const { snapshot, running, connected, busy, error, perform, retry } = scanner;
  const [folders, setFolders] = useState<FolderConfig>({ screenshots: "", logs: "" });
  const edited = useRef(false);
  useEffect(() => { if (snapshot && !edited.current) setFolders(snapshot.config); }, [snapshot]);
  const locked = !connected || !!busy || running;
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

    <ConnectionSection connection={connection} />

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

    <MapDataSection />
    <TileSection />

    <section className="settings-section">
      <h2>Log coverage</h2>
      <LogCoveragePanel snapshot={snapshot} />
    </section>
  </div>;
}

function ConnectionSection({ connection }: { connection: CompanionConnection }) {
  const now = useNow();
  const kind = connection.connection;
  const detail = connectionDetail(connection, now);
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
    {(connection.enabled || !!connection.status?.clients.length) && <ClientList connection={connection} now={now} />}
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
