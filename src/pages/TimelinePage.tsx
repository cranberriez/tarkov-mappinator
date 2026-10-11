import { useState, type CSSProperties } from "react";
import type { Scanner } from "../lib/useScanner";
import type { PositionHistory } from "../lib/positions";
import { positionsForRaid, toPlane } from "../lib/positions";
import { parseTime, raidColor, raidStatus, type RaidRecord, type RaidStatus } from "../lib/raids";
import { longSpan, span } from "../lib/format";
import { ModeChip } from "../components/ModeChip";
import { useNow } from "../lib/useNow";

const endLabel: Record<RaidStatus, string> = { active: "In raid", ended: "Raid ended", unknown: "End not observed" };

function when(value: string | null) {
  const parsed = parseTime(value);
  if (Number.isNaN(parsed)) return "—";
  const date = new Date(parsed);
  const today = new Date().toDateString() === date.toDateString();
  const time = { hour: "2-digit", minute: "2-digit" } as const;
  return today ? date.toLocaleTimeString(undefined, time) : date.toLocaleString(undefined, { month: "short", day: "numeric", ...time });
}

/** Capture order: filename capture minute, then receipt time. */
function inOrder(positions: PositionHistory) {
  return [...positions].sort((a, b) =>
    (parseTime(a.captured_at) || 0) - (parseTime(b.captured_at) || 0) || parseTime(a.observed_at) - parseTime(b.observed_at));
}

export function TimelinePage({ scanner }: { scanner: Scanner }) {
  const { raids, positions, snapshot, clearHistory } = scanner;
  const now = useNow(10_000);
  const [confirming, setConfirming] = useState(false);

  return <div className="page timeline-page">
    <header className="page-header">
      <h1>Timeline</h1>
      {!!raids.length && <button type="button" className={`secondary ${confirming ? "danger" : ""}`}
        onBlur={() => setConfirming(false)}
        onClick={() => { if (confirming) { clearHistory(); setConfirming(false); } else setConfirming(true); }}>
        {confirming ? "Clear raids and positions?" : "Clear history"}</button>}
    </header>

    {raids.length ? <ol className="timeline">
      {raids.map((raid, index) => {
        const status = raidStatus(raid, index, snapshot?.raid);
        const end = status === "active" ? now : parseTime(raid.ended_at);
        const elapsed = end - parseTime(raid.started_at);
        const track = inOrder(positionsForRaid(positions, raid.id));
        // With a track the end row carries the duration; without one it fills the empty span instead.
        const duration = track.length ? span(elapsed) : null;
        return <li key={raid.id} className={`tl-raid ${status}`} style={{ "--raid": raidColor(raid) } as CSSProperties}>
          <div className="tl-node">
            <span className="tl-dot end" />
            <strong>{endLabel[status]}</strong>
            <span className="faint">{status === "ended" ? when(raid.ended_at) : ""}{duration && ` · ${duration}`}</span>
          </div>
          <div className="tl-span">
            {track.length
              ? <RaidTrack raid={raid} positions={track} />
              : <p className="tl-empty">{longSpan(elapsed) ?? "Duration unknown"}<span className="faint"> · no positions</span></p>}
          </div>
          <div className="tl-node">
            <span className="tl-dot start" />
            <strong>{raid.map ?? "Unknown map"}</strong>
            <ModeChip mode={raid.game_mode} />
            <span className="faint">{[raid.player_role, `Started ${when(raid.started_at)}`].filter(Boolean).join(" · ")}</span>
          </div>
        </li>;
      })}
    </ol> : <div className="empty-state"><strong>No raids yet</strong>
      <p>Raids appear here as the scanner observes them starting and ending.</p></div>}
  </div>;
}

function RaidTrack({ raid, positions }: { raid: RaidRecord; positions: PositionHistory }) {
  const points = positions.map(toPlane);
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  // Wide frame (3:1) around the track so short and tall raids both read well.
  const height = Math.max(40, maxY - minY, (maxX - minX) / 3) * 1.3;
  const width = height * 3;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const line = points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
  // Zero-length round-capped strokes give pixel-sized dots regardless of zoom.
  const dot = (p: { x: number; y: number }) => `M${p.x} ${p.y}h0`;
  return <svg className="tl-map" viewBox={`${cx - width / 2} ${cy - height / 2} ${width} ${height}`}
    preserveAspectRatio="xMidYMid meet" aria-label={`${positions.length} positions on ${raid.map ?? "unknown map"}`}>
    <path d={line} className="tl-path" />
    {points.slice(1, -1).map((p, i) => <path key={i} d={dot(p)} className="tl-point" />)}
    <path d={dot(points[0])} className="tl-point first" />
    <path d={dot(points[points.length - 1])} className="tl-point last" />
  </svg>;
}
