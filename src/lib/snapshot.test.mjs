import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptSnapshot } from "./snapshot.ts";
const state = (instance_id, revision) => ({ instance_id, revision });

test("a slow initial fetch cannot replace an event received after subscribing", () => {
  const event = state("session", 12);
  const initialFetch = state("session", 10);
  assert.equal(acceptSnapshot(acceptSnapshot(null, event), initialFetch), event);
});
test("duplicate responses and older events preserve the latest snapshot", () => {
  const current = state("session", 12);
  assert.equal(acceptSnapshot(current, state("session", 12)), current);
  assert.equal(acceptSnapshot(current, state("session", 11)), current);
  assert.equal(acceptSnapshot(current, state("session", 13)).revision, 13);
});
test("reconnection to a new backend instance accepts its reset revision", () => {
  const restarted = state("new-session", 0);
  assert.equal(acceptSnapshot(state("old-session", 50), restarted), restarted);
});
