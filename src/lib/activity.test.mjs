import assert from "node:assert/strict";
import { test } from "node:test";
import { activityEmptyState, activityTimes, evidenceLabel, filterActivity } from "./activity.ts";

const events = [
  { kind: "quest", action: "accept", entity_id: "ABC123", evidence: "requested", recovered: true },
  { kind: "quest", action: "complete", entity_id: "DEF456", evidence: "requested", recovered: false },
  { kind: "raid", action: "started", entity_id: null, evidence: "observed", recovered: false },
];

test("category and case-insensitive ID/action search combine without changing event order", () => {
  assert.deepEqual(filterActivity(events, "quest", " abc ACCEPT "), [events[0]]);
  assert.deepEqual(filterActivity(events, "all", "started"), [events[2]]);
  assert.deepEqual(filterActivity(events, "raid", "accept"), []);
  assert.deepEqual(filterActivity(events, "all", " "), events);
});

test("missing entities and unknown categories do not produce false matches", () => {
  assert.deepEqual(filterActivity(events, "all", "null"), []);
  assert.deepEqual(filterActivity(events, "story", ""), []);
});

test("unknown backend, known empty feed, and empty filters explain different states", () => {
  assert.equal(activityEmptyState(false, 0, false).title, "Activity unknown");
  assert.equal(activityEmptyState(true, 0, true).title, "No supported activity observed");
  assert.match(activityEmptyState(true, 0, false).detail, /Start monitoring/);
  assert.equal(activityEmptyState(true, 3, true).title, "No matching activity");
});

test("recovered requests remain requests and are distinguished from live evidence", () => {
  assert.equal(evidenceLabel(events[0]), "Request only · History");
  assert.equal(evidenceLabel(events[1]), "Request only · Live receipt");
  assert.equal(evidenceLabel(events[2]), "Observed log event · Live receipt");
  assert.equal(evidenceLabel({ evidence: "unexpected", recovered: true }), "Evidence unknown · History");
});

test("quest notification evidence preserves historical origin and unknown source remains searchable by ID", () => {
  const notification = { kind: "quest", action: "accepted", entity_id: "ABC123", source: "unknown", evidence: "quest_notification", recovered: true };
  assert.equal(evidenceLabel(notification), "Quest notification · History");
  assert.deepEqual(filterActivity([notification], "quest", "abc accepted"), [notification]);
  assert.deepEqual(filterActivity([notification], "all", "unknown"), []);
});

test("original notification time is primary and differing log delivery stays visible", () => {
  const original = "2026-10-10T01:00:00Z";
  const logged = "2026-10-11T01:00:00Z";
  assert.deepEqual(activityTimes({ event_at: original, logged_at: logged }), { primary: original, logged });
  assert.deepEqual(activityTimes({ event_at: null, logged_at: logged }), { primary: logged, logged: null });
  assert.deepEqual(activityTimes({ event_at: "2026-10-10T18:00:00-07:00", logged_at: logged }), { primary: "2026-10-10T18:00:00-07:00", logged: null });
});
