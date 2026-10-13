import { useEffect, useRef, useState } from "react";
import type { ActivityEvent } from "../bindings/ActivityEvent";
import type { ToastMode } from "../lib/useToastMode";

const LIFETIME = 6000;
const MAX_VISIBLE = 4;

/** Shows live (non-recovered) activity that arrives after the first snapshot. */
export function Toasts({ events, mode }: { events: ActivityEvent[] | undefined; mode: ToastMode }) {
  const seen = useRef<Set<string> | null>(null);
  const [toasts, setToasts] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    if (!events) return;
    if (!seen.current) { seen.current = new Set(events.map((event) => event.id)); return; }
    const fresh = events.filter((event) => !seen.current!.has(event.id));
    fresh.forEach((event) => seen.current!.add(event.id));
    // Filtered events are still marked seen above, so changing the mode never replays them.
    const live = fresh.filter((event) => !event.recovered && (mode === "all" || (mode === "raid" && event.kind === "raid")));
    if (live.length) setToasts((current) => [...live.reverse(), ...current].slice(0, MAX_VISIBLE));
  }, [events]);

  useEffect(() => { if (mode === "off") setToasts([]); }, [mode]);

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
