import { useState } from "react";
import type { Scanner } from "../lib/useScanner";
import { activityEmptyState, activityFilters, activityTimes, evidenceLabel, filterActivity } from "../lib/activity";
import { timestamp } from "../lib/format";

export function ActivityPage({ scanner }: { scanner: Scanner }) {
  const { snapshot, running } = scanner;
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const events = snapshot?.activity ?? [];
  const visible = filterActivity(events, kind, search);
  const empty = activityEmptyState(!!snapshot, events.length, running);

  return <div className="page">
    <header className="page-header">
      <h1>Activity</h1>
      <div className="segmented" role="group" aria-label="Activity type">
        {activityFilters.map((filter) => <button key={filter.value} type="button"
          className={kind === filter.value ? "selected" : ""} aria-pressed={kind === filter.value}
          onClick={() => setKind(filter.value)}>{filter.label}</button>)}
      </div>
      <input type="search" className="search" value={search} onChange={(event) => setSearch(event.target.value)}
        placeholder="Search" aria-label="Search ID or action" spellCheck={false} />
    </header>

    {visible.length ? <ol className="feed">
      {visible.map((event) => {
        const times = activityTimes(event);
        return <li key={event.id} className={event.recovered ? "recovered" : ""}>
          <span className={`kind-tag kind-${event.kind}`}>{event.kind}</span>
          <div className="feed-body">
            <strong>{event.action}</strong>
            {event.entity_id && <code>{event.entity_id}</code>}
            <span className={`faint ${event.evidence === "requested" ? "requested" : ""}`}>{evidenceLabel(event)}</span>
          </div>
          <time dateTime={times.primary} title={times.logged ? `Logged ${timestamp(times.logged)}` : undefined}>
            {timestamp(times.primary)}</time>
        </li>;
      })}
    </ol> : <div className="empty-state"><strong>{empty.title}</strong><p>{empty.detail}</p></div>}

    {snapshot && <p className="footnote">{visible.length} of {events.length} · last 200 kept{snapshot.activity_dropped ? ` · ${snapshot.activity_dropped} dropped` : ""}</p>}
  </div>;
}
