import { useEffect, useRef, useState } from "react";
import type { ActivityEvent } from "../bindings/ActivityEvent";

const LIFETIME = 6000;
const MAX_VISIBLE = 4;

/** Shows live (non-recovered) activity that arrives after the first snapshot. */
export function Toasts({ events }: { events: ActivityEvent[] | undefined }) {
  const seen = useRef<Set<string> | null>(null);
  const [toasts, setToasts] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    if (!events) return;
    if (!seen.current) { seen.current = new Set(events.map((event) => event.id)); return; }
    const fresh = events.filter((event) => !seen.current!.has(event.id));
    fresh.forEach((event) => seen.current!.add(event.id));
    const live = fresh.filter((event) => !event.recovered);
    if (live.length) setToasts((current) => [...live.reverse(), ...current].slice(0, MAX_VISIBLE));
  }, [events]);

  useEffect(() => {
    if (!toasts.length) return;
    const timer = window.setTimeout(() => setToasts((current) => current.slice(0, -1)), LIFETIME);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  return <div className="toasts" role="status" aria-live="polite">
    {toasts.map((event) => <div key={event.id} className={`toast kind-${event.kind}`}
      onClick={() => setToasts((current) => current.filter((toast) => toast.id !== event.id))}>
      <span className="toast-kind">{event.kind}</span>
      <strong>{event.action}</strong>
      {event.entity_id && <code>{event.entity_id}</code>}
    </div>)}
  </div>;
}
