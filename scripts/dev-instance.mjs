// Runs an extra `tauri dev` instance alongside the usual one, as a separate "person" (e.g. for testing groups).
//   npm run tauri:instance -- <n> [site]      n = 1..9, site e.g. http://localhost:3000
// Instance n gets its own Vite port (1420 + n), Cargo target dir (src-tauri/target/instance-n, so building it
// doesn't touch the running exe; the first build is a full one) and app identifier. The identifier gives it its own
// app data: localStorage (group user id, name, settings), history and map data cache.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const n = Number(process.argv[2]);
if (!Number.isInteger(n) || n < 1 || n > 9) {
  console.error("Usage: npm run tauri:instance -- <1-9> [site]");
  process.exit(1);
}
const site = process.argv[3];
const port = 1420 + n;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "target", `instance-${n}`);
mkdirSync(target, { recursive: true });

// Merged over tauri.conf.json (arrays such as `windows` would be replaced whole, so they're left alone).
const config = join(target, "tauri.instance.json");
writeFileSync(config, JSON.stringify({
  identifier: `local.tarkov-mappinator.instance${n}`,
  productName: `Tarkov Mappinator ${n}`,
  build: { devUrl: `http://127.0.0.1:${port}`, beforeDevCommand: `npm run dev -- --port ${port}` },
}, null, 2));

console.log(`Instance ${n}: Vite on ${port}, target ${target}${site ? `, group site ${site}` : ""}`);
// One command string: `npx` needs a shell on Windows, and Node warns about separate args with `shell`.
const child = spawn(`npx tauri dev --config "${config}"`, {
  cwd: root, stdio: "inherit", shell: true,
  env: { ...process.env, CARGO_TARGET_DIR: target, ...(site ? { VITE_GROUP_SITE: site } : {}) },
});
child.on("exit", (code) => process.exit(code ?? 0));
