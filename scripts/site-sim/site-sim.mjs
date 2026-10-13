#!/usr/bin/env node
// Acts like the Tarkov Hideout site against the companion's real HTTP contract. Node 22+, no dependencies.
// Never imported by the app. See README.md in this folder.
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), ".site-sim.json");
const PORTS = [47615, 47616, 47617, 47618, 47619];
const IDLE_SECONDS = 30;
const RAID_SECONDS = 3;

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    origin: { type: "string", default: "http://localhost:3000" },
    port: { type: "string" },
    interval: { type: "string" },
    "raid-interval": { type: "string" },
    "stop-after": { type: "string" },
    since: { type: "string" },
    "no-token": { type: "boolean", default: false },
    "expect-revoked": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const command = positionals[0];

const time = () => new Date().toLocaleTimeString();
const log = (...parts) => console.log(`[${time()}]`, ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(update) {
  const all = loadState();
  all[opts.origin] = { ...all[opts.origin], ...update };
  writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
}
const saved = () => loadState()[opts.origin] ?? {};

async function call(port, method, path, { token, origin = opts.origin, headers = {} } = {}) {
  const all = { ...headers };
  if (origin) all.Origin = origin;
  if (token) all.Authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: all });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, headers: response.headers, body };
}

/** The port the companion answered on, from --port, the saved pairing, or a scan of the range. */
async function findPort() {
  const candidates = opts.port ? [Number(opts.port)] : [...new Set([saved().port, ...PORTS].filter(Boolean))];
  for (const port of candidates) {
    try {
      const { status, body } = await call(port, "GET", "/v1/status");
      if (status === 200 && body?.app === "tarkov-mappinator") return port;
    } catch { /* closed */ }
  }
  throw new Error(`No companion on ${candidates.join(", ")} for origin ${opts.origin}. Is the connection enabled in the app?`);
}

async function pair() {
  const port = await findPort();
  const requested = await call(port, "POST", "/v1/pair");
  if (requested.status !== 202) throw new Error(`Pairing refused: ${requested.status} ${JSON.stringify(requested.body)}`);
  const { pairing_id: id, expires_in_secs: ttl } = requested.body;
  log(`Pairing ${id} on port ${port}. Allow or deny it in the app (expires in ${ttl}s)…`);
  for (;;) {
    await sleep(1000);
    const { body } = await call(port, "GET", `/v1/pair/${id}`);
    if (body?.state === "pending") continue;
    if (body?.state === "allowed") {
      saveState({ port, token: body.token, cursor: 0, epoch: null });
      log(`Allowed. Token saved to ${STATE_FILE}.`);
      return;
    }
    log(`Pairing ${body?.state ?? "failed"}.`);
    process.exitCode = 1;
    return;
  }
}

function describe(event) {
  const where = (map) => map ? map.normalized_name ?? map.raw : "unknown map";
  const flags = [event.recovered && "recovered", event.mode].filter(Boolean).join(", ");
  const tail = flags ? ` (${flags})` : "";
  switch (event.kind) {
    case "quest": return `#${event.seq} quest ${event.action} ${event.quest_id}${tail}`;
    case "raid": return `#${event.seq} raid ${event.phase} ${where(event.map)}${tail}`;
    case "position": return `#${event.seq} position ${where(event.map)} x=${event.x} y=${event.y} z=${event.z} yaw=${event.yaw ?? "?"}${tail}`;
    default: return `#${event.seq} ${JSON.stringify(event)}`;
  }
}

async function poll() {
  const { token } = saved();
  if (!token) throw new Error("Not paired. Run `pair` first.");
  const port = await findPort();
  const idle = Number(opts.interval ?? IDLE_SECONDS);
  const raid = Number(opts["raid-interval"] ?? RAID_SECONDS);
  const stopAt = opts["stop-after"] ? Date.now() + Number(opts["stop-after"]) * 1000 : Infinity;
  let cursor = opts.since !== undefined ? Number(opts.since) : saved().cursor ?? 0;
  let epoch = saved().epoch ?? null;
  let lastState = null;
  log(`Polling port ${port} from seq ${cursor}: every ${idle}s idle, ${raid}s in raid.`);
  while (Date.now() < stopAt) {
    const response = await call(port, "GET", `/v1/sync?since=${cursor}`, { token });
    if (response.status === 401) { log(`Rejected: ${response.body?.error}. Pair again.`); process.exitCode = 1; return; }
    if (response.status === 400 && response.body?.error === "bad_cursor") {
      log("Cursor ahead of the app (it restarted). Resyncing from 0.");
      cursor = 0; epoch = null; continue;
    }
    if (response.status !== 200) { log(`Error ${response.status}: ${JSON.stringify(response.body)}`); }
    else {
      const sync = response.body;
      if (epoch && sync.epoch !== epoch) {
        log(`App restarted (epoch ${epoch} → ${sync.epoch}). Resyncing from 0.`);
        epoch = sync.epoch; cursor = 0; continue;
      }
      epoch = sync.epoch;
      if (cursor > 0 && sync.oldest > cursor + 1) log(`Gap: events ${cursor + 1}–${sync.oldest - 1} were dropped.`);
      for (const event of sync.events) log(describe(event));
      cursor = sync.seq;
      const state = JSON.stringify(sync.state);
      if (state !== lastState) {
        const { raid: current, scanner_running: running, position } = sync.state;
        log(`state: scanner ${running ? "running" : "stopped"}, raid ${current ? `${current.phase} ${current.map?.normalized_name ?? current.map?.raw ?? "?"}` : "none"}, position ${position ? "set" : "none"}`);
        lastState = state;
      }
      saveState({ port, cursor, epoch });
    }
    const inRaid = response.body?.state?.raid?.phase === "in_raid";
    const wait = Math.min((inRaid ? raid : idle) * 1000, Math.max(0, stopAt - Date.now()));
    if (wait > 0) await sleep(wait);
  }
  log("Stopped polling (--stop-after). The app should show stale after its threshold.");
}

async function status() {
  const port = await findPort();
  const token = opts["no-token"] ? undefined : saved().token;
  const response = await call(port, "GET", "/v1/status", { token });
  log(`${response.status} ${JSON.stringify(response.body, null, 2)}`);
  if (response.status !== 200) process.exitCode = 1;
}

/** Raw request so Host can be forged (fetch won't). */
function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume(); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function checks() {
  const port = await findPort();
  const { token } = saved();
  const results = [];
  const check = async (name, run) => {
    try {
      const outcome = await run();
      if (outcome === "skip") { results.push("skip"); console.log(`SKIP  ${name}`); return; }
      const [ok, detail] = outcome;
      results.push(ok);
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    } catch (error) {
      results.push(false);
      console.log(`FAIL  ${name} — ${error.message}`);
    }
  };
  const errorIs = (response, status, code) =>
    [response.status === status && response.body?.error === code, `${response.status} ${response.body?.error ?? ""}`.trim()];

  await check("disallowed Origin is rejected without CORS headers", async () => {
    const response = await call(port, "GET", "/v1/status", { origin: "https://evil.example" });
    const [ok, detail] = errorIs(response, 403, "origin_not_allowed");
    return [ok && !response.headers.get("access-control-allow-origin"), detail];
  });
  await check("missing Origin is rejected", async () => errorIs(await call(port, "GET", "/v1/status", { origin: null }), 403, "origin_required"));
  await check("forged Host is rejected (DNS rebinding)", async () => {
    const response = await rawGet(port, "/v1/status", { Origin: opts.origin, Host: `attacker.example:${port}` });
    return [response.status === 421, String(response.status)];
  });
  await check("sync without a token is rejected", async () => errorIs(await call(port, "GET", "/v1/sync?since=0"), 401, "token_required"));
  await check("sync with an unknown token is rejected", async () =>
    errorIs(await call(port, "GET", "/v1/sync?since=0", { token: "0".repeat(64) }), 401, "invalid_token"));
  await check("revoked token is rejected (--expect-revoked)", async () => {
    if (!opts["expect-revoked"]) return "skip";
    if (!token) throw new Error("no saved token");
    return errorIs(await call(port, "GET", "/v1/sync?since=0", { token }), 401, "invalid_token");
  });
  await check("token from another origin is rejected", async () => {
    if (!token || opts["expect-revoked"]) return "skip";
    const other = opts.origin === "http://localhost:3000" ? "http://127.0.0.1:3000" : "http://localhost:3000";
    return errorIs(await call(port, "GET", "/v1/sync?since=0", { token, origin: other }), 401, "invalid_token");
  });
  await check("non-numeric cursor is rejected", async () => {
    if (!token || opts["expect-revoked"]) return "skip";
    return errorIs(await call(port, "GET", "/v1/sync?since=abc", { token }), 400, "bad_cursor");
  });
  await check("cursor ahead of the journal is rejected", async () => {
    if (!token || opts["expect-revoked"]) return "skip";
    return errorIs(await call(port, "GET", "/v1/sync?since=999999999", { token }), 400, "bad_cursor");
  });
  await check("OPTIONS preflight with Access-Control-Request-Private-Network", async () => {
    const response = await call(port, "OPTIONS", "/v1/sync?since=0", {
      headers: {
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    const h = (name) => response.headers.get(name);
    const ok = response.status === 204
      && h("access-control-allow-origin") === opts.origin
      && h("access-control-allow-private-network") === "true"
      && /authorization/i.test(h("access-control-allow-headers") ?? "")
      && /GET/.test(h("access-control-allow-methods") ?? "");
    const shown = ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers",
      "access-control-allow-private-network", "access-control-allow-local-network", "access-control-max-age"]
      .map((name) => `\n        ${name}: ${h(name)}`).join("");
    return [ok, `${response.status}${shown}`];
  });
  await check("OPTIONS preflight from a disallowed Origin is rejected", async () => {
    const response = await call(port, "OPTIONS", "/v1/sync", {
      origin: "https://evil.example",
      headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Private-Network": "true" },
    });
    return [response.status === 403 && !response.headers.get("access-control-allow-origin"), String(response.status)];
  });

  const failed = results.filter((result) => result === false).length;
  console.log(`\n${results.filter((result) => result === true).length} passed, ${failed} failed, ${results.filter((result) => result === "skip").length} skipped`);
  if (failed) process.exitCode = 1;
}

const commands = { pair, poll, status, checks };
if (!commands[command] || opts.help) {
  console.log(`Usage: node scripts/site-sim/site-sim.mjs <pair|poll|status|checks> [options]
  --origin <url>          Origin to send (default http://localhost:3000)
  --port <n>              Skip discovery
  poll: --interval <s> (idle, default ${IDLE_SECONDS}) --raid-interval <s> (default ${RAID_SECONDS}) --stop-after <s> --since <seq>
  status: --no-token      Unauthenticated status
  checks: --expect-revoked  After revoking in the app: the saved token must be rejected`);
  process.exit(command ? 1 : 0);
}
commands[command]().catch((error) => { console.error(error.message); process.exitCode = 1; });
