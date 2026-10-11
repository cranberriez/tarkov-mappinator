import assert from "node:assert/strict";
import { test } from "node:test";
import { dataMode } from "./mode.ts";

test("log session modes select tarkov.dev data sets", () => {
  assert.equal(dataMode("Pve"), "pve");
  assert.equal(dataMode("Regular"), "regular");
  assert.equal(dataMode("PvpSeason"), "pvp-season");
  assert.equal(dataMode(null), "pve");
  assert.equal(dataMode("Arena"), "pve");
});
