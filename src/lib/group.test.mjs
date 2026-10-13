import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPosition, applyRaid, assignColors, cleanName, createPacer, defaultName, MEMBER_COLORS, newCode, normalizeCode, normalizeSite, parsePosition, parseRaid,
  validName, waiting,
} from "./group.ts";

test("codes round-trip through normalizing and avoid ambiguous characters", () => {
  for (let i = 0; i < 200; i++) {
    const code = newCode();
    assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
    assert.equal(normalizeCode(code.toLowerCase()), code);
  }
  assert.equal(normalizeCode("abc-23 4"), "ABC234");
  assert.equal(normalizeCode("ABC0O1"), null);
  assert.equal(normalizeCode("ABC23"), null);
});

test("names follow Tarkov's rules", () => {
  assert.ok(validName(defaultName()));
  assert.ok(defaultName().length <= 15);
  assert.equal(cleanName("Big Boss!! éé 1234567890"), "BigBoss12345678");
  assert.equal(validName(""), false);
});

test("messages are validated", () => {
  assert.deepEqual(parseRaid({ from: "a", inRaid: true, map: "bigmap" }), { from: "a", inRaid: true, map: "bigmap" });
  assert.equal(parseRaid({ from: "a", inRaid: "yes", map: null }), null);
  const position = { from: "a", map: "bigmap", x: 1, y: 2, z: 3, heading: null, at: "2026-10-13T10:00:00Z" };
  assert.deepEqual(parsePosition(position), position);
  assert.equal(parsePosition({ ...position, x: Infinity }), null);
  assert.equal(parsePosition({ ...position, at: "soon" }), null);
  assert.equal(parsePosition(null), null);
});

test("raid end drops the marker; positions imply in raid", () => {
  const placed = applyPosition(waiting, { from: "a", map: "bigmap", x: 1, y: 0, z: 2, heading: 90, at: "2026-10-13T10:00:00Z" });
  assert.equal(placed.status, "in-raid");
  assert.equal(placed.position.x, 1);
  assert.equal(applyRaid(placed, { from: "a", inRaid: true, map: "bigmap" }).position, placed.position);
  assert.equal(applyRaid(placed, { from: "a", inRaid: true, map: "woods" }).position, null);
  assert.deepEqual(applyRaid(placed, { from: "a", inRaid: false, map: null }), { status: "out-of-raid", map: null, position: null });
});

test("colours stay with members and newcomers take free ones", () => {
  const first = assignColors(["a", "b"], new Map());
  assert.deepEqual([...first.values()], MEMBER_COLORS.slice(0, 2));
  const next = assignColors(["b", "c"], first);
  assert.equal(next.get("b"), first.get("b"));
  assert.equal(next.get("c"), MEMBER_COLORS[0]);
});

test("pacer spaces positions and caps bursts", () => {
  const pacer = createPacer({ positionMs: 1000, burst: 3, windowMs: 10_000 });
  assert.equal(pacer.take(0, "position"), true);
  assert.equal(pacer.positionWait(400), 600);
  assert.equal(pacer.take(400, "position"), false);
  assert.equal(pacer.take(500, "raid"), true);
  assert.equal(pacer.take(1000, "position"), true);
  assert.equal(pacer.take(1100, "raid"), false);
  assert.equal(pacer.take(10_001, "raid"), true);
});

test("sites normalize to their origin", () => {
  assert.equal(normalizeSite("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(normalizeSite(" dev.tarkovhideout.com "), "https://dev.tarkovhideout.com");
  assert.equal(normalizeSite("localhost:3000/"), "http://localhost:3000");
  assert.equal(normalizeSite("127.0.0.1:3001"), "http://127.0.0.1:3001");
  assert.equal(normalizeSite("https://www.tarkovhideout.com/api/group/auth"), "https://www.tarkovhideout.com");
  assert.equal(normalizeSite("ftp://example.com"), null);
  assert.equal(normalizeSite("not a url"), null);
  assert.equal(normalizeSite(""), null);
});
