type SearchableActivity = { kind: string; action: string; entity_id: string | null };

export const activityFilters = [
  { value: "all", label: "All" },
  { value: "quest", label: "Quests" },
  { value: "story", label: "Story" },
  { value: "raid", label: "Raid" },
  { value: "session", label: "Session" },
] as const;

export function filterActivity<T extends SearchableActivity>(events: readonly T[], kind: string, search: string): T[] {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return events.filter((event) => {
    if (kind !== "all" && event.kind !== kind) return false;
    const text = `${event.entity_id ?? ""} ${event.action}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function activityEmptyState(known: boolean, retained: number, running: boolean) {
  if (!known) return { title: "Activity unknown", detail: "Connect to the desktop backend to inspect local log evidence." };
  if (retained > 0) return { title: "No matching activity", detail: "Choose All or clear the search to see retained events." };
  return {
    title: "No supported activity observed",
    detail: running
      ? "Monitoring logs. Supported events will appear as evidence arrives; coverage below includes records without a recognized activity event."
      : "Start monitoring to inspect existing log history and receive new events.",
  };
}

export function evidenceLabel(event: { evidence: string; recovered: boolean }) {
  const evidence = event.evidence === "requested" ? "Request only"
    : event.evidence === "quest_notification" ? "Quest notification"
    : event.evidence === "observed" ? "Observed log event" : "Evidence unknown";
  return `${evidence} · ${event.recovered ? "History" : "Live receipt"}`;
}

export function activityTimes(event: { event_at: string | null; logged_at: string }) {
  const primary = event.event_at ?? event.logged_at;
  const sameTime = primary === event.logged_at || Date.parse(primary) === Date.parse(event.logged_at);
  return { primary, logged: sameTime ? null : event.logged_at };
}
