import type { Scanner } from "../lib/useScanner";
import type { PositionHistory } from "../lib/positions";
import { freshness, positionsForRaid, toPlane } from "../lib/positions";
import { age, clock, lifecycleLabel, timestamp } from "../lib/format";
import { useNow } from "../lib/useNow";
import type { Page } from "../components/Sidebar";
import { ModeChip } from "../components/ModeChip";

export function OverviewPage({ scanner, onNavigate }: { scanner: Scanner; onNavigate: (page: Page) => void }) {
  const { snapshot, positions, running, connected, desktop } = scanner;
  const now = useNow();
  const raid = snapshot?.raid;
  const known = !!raid && raid.lifecycle !== "unknown";
  const raidPositions = positionsForRaid(positions, known ? raid.id : null);
  const latest = raidPositions[raidPositions.length - 1];
  const activity = snapshot?.activity ?? [];
  const raidStart = known && raid.started_at ? Date.parse(raid.started_at) : NaN;
  const raidEvents = Number.isNaN(raidStart) ? [] : activity.filter((event) => Date.parse(event.event_at ?? event.logged_at) >= raidStart);
  const sourcesOk = snapshot?.screenshots.status === "available" && snapshot?.logs.status === "available";
  const diagnostics = snapshot?.diagnostics ?? [];

  const session: [string, string | number][] = [
    ["Screenshots", snapshot?.screenshots_seen ?? "—"],
    ["Rejected", snapshot?.screenshots_rejected ?? "—"],
    ["Positions", positions.length],
    ["Events", activity.length],
  ];

  const duration = known && raid.lifecycle === "active" ? age(raid.started_at, now) : null;
  // Priority 1 survives the smallest layouts; 3 is the first to go.
  const details: [string, string, 1 | 2 | 3][] = [
    ["Game mode", raid?.game_mode ?? "—", 1],
    ["Role", raid?.player_role ?? "—", 1],
    ["Positions", String(raidPositions.length), 1],
    ["Events", String(raidEvents.length), 2],
    ["Started", known ? timestamp(raid.started_at) : "—", 2],
    ["Evidence", !known ? "—" : raid.recovered ? "Log history" : "Observed live", 3],
    ["Raid ID", raid?.id ?? "—", 3],
  ];

  return <div className="overview-host"><div className="overview">
    <aside className="overview-side">
      <section>
        <h2>Session</h2>
        <div className="stat-grid">
          {session.map(([label, value]) => <div key={label} className="stat"><span>{label}</span><strong>{value}</strong></div>)}
        </div>
      </section>

      <section className="scanner">
        <h2>Scanner<button type="button" className="link" onClick={() => onNavigate("settings")}>Settings</button></h2>
        <ul className="plain-list">
          <li title={connected ? "Connected" : desktop ? "Disconnected" : "Browser preview"}><span className={`dot ${connected ? "ok" : desktop ? "bad" : ""}`} />Backend<span className="faint">{connected ? "Connected" : desktop ? "Disconnected" : "Browser preview"}</span></li>
          <li title={running ? "Running" : "Stopped"}><span className={`dot ${running ? "ok" : ""}`} />Monitoring<span className="faint">{running ? "Running" : "Stopped"}</span></li>
          <li title={sourcesOk ? "Accessible" : "Check settings"}><span className={`dot ${sourcesOk ? "ok" : snapshot ? "warn" : ""}`} />Sources
            <button type="button" className="link" onClick={() => onNavigate("settings")}>{sourcesOk ? "Accessible" : "Check settings"}</button></li>
          <li title={`${diagnostics.length} issues`}><span className={`dot ${diagnostics.length ? "warn" : snapshot ? "ok" : ""}`} />Diagnostics
            <span className="faint">{snapshot ? diagnostics.length ? `${diagnostics.length} issue${diagnostics.length > 1 ? "s" : ""}` : "None" : "—"}</span></li>
        </ul>
      </section>

      <section className="grow recent">
        <h2>Recent activity<button type="button" className="link" onClick={() => onNavigate("activity")}>View all</button></h2>
        {activity.length ? <ul className="plain-list scroll" onClick={() => onNavigate("activity")}>
          {activity.slice(0, 40).map((event) => <li key={event.id} className={event.recovered ? "recovered" : ""}>
            <span className={`kind-tag kind-${event.kind}`}>{event.kind}</span>{event.action}
            <span className="faint">{clock(event.event_at ?? event.logged_at)}</span>
          </li>)}
        </ul> : <p className="faint">Nothing yet.</p>}
      </section>
    </aside>

    <section className="raid-panel">
      <header className="raid-header">
        <span className={`hero-state ${raid?.lifecycle ?? "unknown"}`}>
          {known ? lifecycleLabel[raid.lifecycle] ?? raid.lifecycle : "Waiting for a raid"}
          {known && (raid.recovered ? " · from history" : running ? " · live" : "")}
          {duration && <span className="duration"> · {duration}</span>}
        </span>
        <h1>{raid?.map ?? "No map"}</h1>
        {raid?.detail && <p className="faint raid-note">{raid.detail}</p>}
      </header>

      <dl className="raid-details">
        {details.map(([label, value, priority]) => <div key={label} className={`p${priority}`}><dt>{label}</dt><dd title={value}>{label === "Game mode" && raid?.game_mode ? <ModeChip mode={raid.game_mode} /> : value}</dd></div>)}
      </dl>

      <div className="raid-body">
        <button type="button" className="minimap" onClick={() => onNavigate("map")} title="Open map">
          <MiniMap positions={raidPositions} now={now} />
          <span className="minimap-label">Positions this raid</span>
        </button>

        <div className="raid-position">
          <h2>Latest position</h2>
          {latest ? <>
            <div className="coords">
              {(["X", "Y", "Z"] as const).map((axis, index) => <div key={axis}><span>{axis}</span><strong>{latest.xyz[index].toFixed(1)}</strong></div>)}
            </div>
            <dl className="kv">
              <div className="p1"><dt>Heading</dt><dd>{latest.heading_degrees === null ? "—" : `${latest.heading_degrees.toFixed(0)}°`}<span className="faint"> unverified</span></dd></div>
              <div className="p1"><dt>Received</dt><dd>{age(latest.observed_at, now)} ago</dd></div>
              <div className="p2"><dt>Captured</dt><dd>{latest.captured_at ? clock(latest.captured_at) : "—"}</dd></div>
              <div className="p3"><dt>File</dt><dd className="mono" title={latest.filename}>{latest.filename}</dd></div>
            </dl>
          </> : <p className="faint">Take a screenshot in raid to record a position.</p>}
        </div>
      </div>
    </section>
  </div></div>;
}

/** Static plot of positions fitted to their bounds. */
function MiniMap({ positions, now }: { positions: PositionHistory; now: number }) {
  if (!positions.length) return <svg className="minimap-svg" />;
  const points = positions.map(toPlane);
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const span = Math.max(50, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.25;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const r = span * 0.011;
  const newest = points[points.length - 1];
  const fresh = freshness(positions[positions.length - 1].observed_at, now);
  return <svg className="minimap-svg" viewBox={`${cx - span / 2} ${cy - span / 2} ${span} ${span}`} preserveAspectRatio="xMidYMid meet">
    {points.slice(0, -1).map((p, index) => <circle key={index} cx={p.x} cy={p.y} r={r}
      fill="var(--marker-old)" opacity={0.2 + (index + 1) / points.length * 0.45} />)}
    <circle cx={newest.x} cy={newest.y} r={r * (3 + fresh * 2)} fill="var(--accent-strong)" opacity={0.08 + fresh * 0.15} />
    <circle cx={newest.x} cy={newest.y} r={r * 1.9} fill="var(--accent-strong)" />
  </svg>;
}
