import { useState } from "react";
import type { ScannerSnapshot } from "../bindings/ScannerSnapshot";
import { activityEmptyState, activityFilters, activityTimes, evidenceLabel, filterActivity } from "../lib/activity";

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function ActivityPanel({ snapshot }: { snapshot: ScannerSnapshot | null }) {
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const events = snapshot?.activity ?? [];
  const visible = filterActivity(events, kind, search);
  const empty = activityEmptyState(!!snapshot, events.length, snapshot?.monitoring === "running");
  const dropped = snapshot?.activity_dropped ?? 0;

  return <section className="panel activity">
    <div className="section-heading"><span className="number">03</span><h2>Quests & game activity</h2>
      <span className="badge">{snapshot ? `${events.length} retained` : "Unknown"}</span>
    </div>
    <p className="activity-intro">Structured evidence from local logs. “Request only” shows an attempted action. “Quest notification” identifies a game notice and uses its original event time when available. History includes older notifications; live receipt does not mean the action just occurred.</p>
    <div className="activity-controls">
      <div className="activity-filters" role="group" aria-label="Activity type">
        {activityFilters.map((filter) => <button key={filter.value} type="button"
          className={`secondary ${kind === filter.value ? "selected" : ""}`} aria-pressed={kind === filter.value}
          onClick={() => setKind(filter.value)}>{filter.label}</button>)}
      </div>
      <div className="activity-search"><label htmlFor="activity-search">Search ID or action</label>
        <input id="activity-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="Entity ID or action" spellCheck={false} />
      </div>
    </div>
    <div className="activity-retention">
      <span>{snapshot ? `Showing ${visible.length} of ${events.length} retained events · newest event time first` : "No backend activity available"}</span>
      <span>{snapshot ? `${dropped} older events evicted · last 200 retained` : "Retention unknown"}</span>
    </div>
    {visible.length ? <ol className="activity-feed" aria-label="Log activity events">
      {visible.map((event) => {
        const times = activityTimes(event);
        return <li key={event.id} className="activity-event">
        <div className="activity-event-heading"><strong>{event.action}</strong><span className="badge">{event.kind}</span>
          <time dateTime={times.primary}>{timestamp(times.primary)}</time></div>
        <p>{event.summary}</p>
        <div className="activity-event-meta"><span>Entity ID <code>{event.entity_id ?? "Not supplied"}</code></span>
          <span>Source <code>{event.source || "Unknown"}</code></span><span className={event.evidence === "requested" ? "request-evidence" : ""}>{evidenceLabel(event)}</span>
          {times.logged && <span>Logged <time dateTime={times.logged}>{timestamp(times.logged)}</time></span>}</div>
      </li>; })}
    </ol> : <div className="activity-empty"><h3>{empty.title}</h3><p>{empty.detail}</p></div>}

  </section>;
}
