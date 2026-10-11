import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptSnapshot, checkFolders, getSnapshot, isTauri, onSnapshot, startScanner, stopScanner,
  type FolderConfig, type ScannerSnapshot,
} from "./lib/scanner";
import type { SourceHealth } from "./bindings/SourceHealth";
import { ActivityPanel } from "./components/ActivityPanel";

const emptyFolders: FolderConfig = { screenshots: "", logs: "" };
const labels: Record<SourceHealth["status"], string> = {
  not_configured: "Not configured", available: "Accessible", missing: "Missing folder",
  not_directory: "Not a folder", unreadable: "Cannot access",
};
const lifecycleLabels: Record<string, string> = { unknown: "Unknown", loading: "Loading scene · raid not started", active: "In raid", ended: "Raid ended" };

function Source({ title, health }: { title: string; health?: SourceHealth }) {
  return <div className="source">
    <div className="row"><h3>{title}</h3><span className={`badge ${health?.status === "available" ? "good" : ""}`}>
      {health ? labels[health.status] : "Unknown"}
    </span></div>
    <p>{health?.detail ?? "Open the desktop app to check local folders."}</p>
  </div>;
}

function timestamp(value: string | null | undefined) {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function captureTimestamp(value: string | null | undefined) {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, {
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}
function captureAge(value: string | null | undefined, now: number) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : Math.max(0, Math.floor((now - time) / 1000));
}
function ageLabel(seconds: number) {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ago`;
}
const numeric = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 4 });

export function App() {
  const desktop = isTauri();
  const [snapshot, setSnapshot] = useState<ScannerSnapshot | null>(null);
  const [folders, setFolders] = useState<FolderConfig>(emptyFolders);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const edited = useRef(false);
  const currentSnapshot = useRef<ScannerSnapshot | null>(null);
  const receive = useCallback((next: ScannerSnapshot) => {
    const accepted = acceptSnapshot(currentSnapshot.current, next);
    currentSnapshot.current = accepted;
    setSnapshot(accepted);
    if (!edited.current) setFolders(accepted.config);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setConnected(false);
    setError(null);
    // Subscribe first; revision ordering protects against a slower initial fetch.
    void (async () => {
      try {
        const cleanup = await onSnapshot((next) => { if (!disposed) receive(next); });
        if (disposed) { cleanup(); return; }
        unlisten = cleanup;
        const initial = await getSnapshot();
        if (disposed) return;
        receive(initial);
        setConnected(true);
      } catch (cause) {
        unlisten?.();
        unlisten = undefined;
        if (!disposed) setError(String(cause));
      }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, [desktop, receive, connectionAttempt]);

  async function perform(action: "check" | "start" | "stop") {
    setBusy(action);
    setError(null);
    try {
      const config = { screenshots: folders.screenshots.trim(), logs: folders.logs.trim() };
      const result = action === "stop" ? await stopScanner() : action === "start" ? await startScanner(config) : await checkFolders(config);
      edited.current = false;
      receive(result);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }

  const running = snapshot?.monitoring === "running";
  const position = snapshot?.latest_position;
  const age = captureAge(position?.captured_at, now);
  const receivedAge = captureAge(position?.observed_at, now);
  const stale = receivedAge !== null && receivedAge > 30;
  const raid = snapshot?.raid;
  const liveRaid = running && raid?.lifecycle === "active" && !raid.recovered;
  const recoveredRaid = running && raid?.recovered && raid.lifecycle === "active";
  const locked = !connected || !!busy || running;

  return <main>
    <header>
      <div><p className="eyebrow">TARKOV MAPPINATOR / LOCAL DIAGNOSTICS</p>
        <h1>Know what’s known.</h1><p className="intro">Passive raid context and screenshot positions, backed by local files.</p>
      </div>
      <span className={`badge ${connected ? "good" : ""}`}><span className="dot" />
        {connected ? "Backend connected" : desktop ? "Backend disconnected" : "Browser preview"}
      </span>
    </header>

    <aside className={`notice ${liveRaid ? "raid-live" : ""}`} role="status" aria-live="polite">
      <strong>{!snapshot ? "Scanner state unknown" : liveRaid ? "Raid start detected live" : recoveredRaid ? "Active raid recovered from existing logs" : running ? "Monitoring local files" : "Scanner stopped"}</strong>
      <p>{liveRaid ? `Started ${timestamp(raid?.started_at)} · ${raid?.map ?? "Map unknown"}` : recoveredRaid ? "This state was found in log history. A new raid start has not been observed live." : running ? "Take a game screenshot to record a position. The last capture stays visible until another arrives." : snapshot ? "Any displayed raid and position are preserved observations. Start monitoring to receive new evidence." : "Choose your source folders and start monitoring to observe raid events and screenshot positions."}</p>
    </aside>
    {!desktop && <p className="preview-note">Local file access requires the desktop app. Launch with <code>npm run tauri dev</code>. No live scanner data is available in this preview.</p>}
    {error && <div className="error" role="alert">{error}
      {!connected && <button onClick={() => setConnectionAttempt((value) => value + 1)}>Retry connection</button>}
    </div>}

    <div className="grid">
      <section className="panel folders">
        <div className="section-heading"><span className="number">01</span><h2>Sources</h2><span className={`badge ${running ? "good" : ""}`}>{snapshot ? running ? "Monitoring" : "Stopped" : "Unknown"}</span></div>
        <form onSubmit={(event) => { event.preventDefault(); void perform("check"); }}>
          <label htmlFor="screenshots">Screenshot folder</label>
          <input id="screenshots" value={folders.screenshots} placeholder="Paste an absolute folder path"
            spellCheck={false} disabled={locked}
            onChange={(event) => { edited.current = true; setFolders({ ...folders, screenshots: event.target.value }); }} />
          <label htmlFor="logs">Game log folder</label>
          <input id="logs" value={folders.logs} placeholder="Paste the Tarkov installation’s Logs folder"
            spellCheck={false} disabled={locked}
            onChange={(event) => { edited.current = true; setFolders({ ...folders, logs: event.target.value }); }} />
          <div className="actions">
            <button type="button" disabled={!connected || !!busy} onClick={() => void perform(running ? "stop" : "start")}>
              {busy === "start" ? "Starting…" : busy === "stop" ? "Stopping…" : running ? "Stop monitoring" : "Start monitoring"}
            </button>
            <button className="secondary" type="submit" disabled={locked}>{busy === "check" ? "Checking…" : "Check folders"}</button>
          </div>
          <p className="muted">{running ? "Stop monitoring to change source folders." : "Detected folders appear automatically when available. Settings last for this app session."}</p>
        </form>
        <Source title="Screenshots" health={snapshot?.screenshots} />
        <Source title="Game logs" health={snapshot?.logs} />
      </section>

      <section className="panel">
        <div className="section-heading"><span className="number">02</span><h2>Raid context</h2></div>
        <span className={`badge ${liveRaid ? "good" : ""}`}>{raid ? `${running ? "" : "Last observed: "}${lifecycleLabels[raid.lifecycle] ?? raid.lifecycle}` : "Unknown"}</span>
        <dl><div><dt>Map</dt><dd>{raid?.map ?? "Unknown"}</dd></div>
          <div><dt>Game mode</dt><dd>{raid?.game_mode ?? "Unknown"}</dd></div>
          <div><dt>Player role</dt><dd>{raid?.player_role ?? "Unknown"}</dd></div>
          <div><dt>Raid association</dt><dd>{raid?.id ?? "Not established"}</dd></div>
          <div><dt>Raid started</dt><dd>{timestamp(raid?.started_at)}</dd></div>
          <div><dt>Evidence</dt><dd>{raid?.recovered ? "Recovered log history" : raid && raid.lifecycle !== "unknown" ? "Observed this session" : "Unknown"}</dd></div></dl>
        <p className="muted">{raid?.detail ?? "No backend evidence available."}</p>
      </section>

      <section className="panel position">
        <div className="section-heading"><span className="number">03</span><h2>Last captured position</h2>
          <span className={`badge ${stale ? "warning" : ""}`}>{!position ? "No observation" : !running ? "Preserved observation" : receivedAge === null ? "Receipt time unknown" : stale ? "No recent receipt" : "Recently received"}</span>
        </div>
        {position ? <>
          <div className="coordinates">{position.xyz.map((value, index) => <div key={index}><span>{["X", "Y", "Z"][index]}</span><strong>{numeric(value)}</strong></div>)}</div>
          <dl className="capture-details">
            <div><dt>Raw quaternion (filename order)</dt><dd className="mono">{position.raw_quaternion.map(String).join(" · ")}</dd></div>
            <div><dt>Provisional coordinate yaw</dt><dd>{position.heading_degrees === null ? "Unknown" : `${numeric(position.heading_degrees)}°`}</dd></div>
            <div><dt>Screenshot filename</dt><dd className="mono">{position.filename}</dd></div>
            <div><dt>Capture raid association</dt><dd>{position.raid_id ?? "Not established"}</dd></div>
          </dl>
          <p className="muted">Heading assumes quaternion order X, Y, Z, W and Unity yaw. Component order and compass alignment are unverified.</p>
        </> : <div className="empty"><div className="crosshair" aria-hidden="true">+</div>
          <div><h3>No position observed</h3><p>World XYZ and rotation will appear after a screenshot filename is successfully parsed.</p></div></div>}
        <div className="position-meta"><span>Captured <strong>{captureTimestamp(position?.captured_at)}</strong></span>
          <span>Capture age <strong>{age === null ? "Unknown" : `About ${Math.floor(age / 60)} min ago (minute precision)`}</strong></span>
          <span>Last received <strong>{receivedAge === null ? "Unknown" : ageLabel(receivedAge)}</strong></span></div>
        <p className="muted">Filename capture times have minute precision. Freshness reflects time since the scanner received the file; after 30 seconds the receipt is marked old. Positions update only on screenshots and do not track movement between captures.</p>
      </section>
      <ActivityPanel snapshot={snapshot} />
      <section className="panel diagnostics">
        <div className="section-heading"><span className="number">05</span><h2>Scanner diagnostics</h2></div>
        <div className="position-meta"><span>Screenshots seen <strong>{snapshot?.screenshots_seen ?? "Unknown"}</strong></span>
          <span>Rejected captures <strong>{snapshot?.screenshots_rejected ?? "Unknown"}</strong></span></div>
        {snapshot?.diagnostics.length ? <ul>{snapshot.diagnostics.map((detail, index) => <li key={index}>{detail}</li>)}</ul> : <p className="muted">{snapshot ? "No scanner issues reported." : "No backend evidence available."}</p>}
      </section>
    </div>
    <footer><span>Passive files only · Screenshot-driven positions · Closing the app ends the session</span>
      <span>{snapshot ? `State revision ${snapshot.revision}` : "No scanner state"}</span></footer>
  </main>;
}
