// Dev server only: the floor dataset (src/lib/floorData.ts), one file per map in scripts/data/floor-samples/<map>.json.
// GET /__dev/floor-data/<map> reads it (an empty dataset when there is none); POST writes the whole dataset back.
// Kept apart from the floor table and calibration until exported; nothing in src imports these files, so writes don't reload.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const dir = new URL("./data/floor-samples/", import.meta.url);
const round = (value) => Math.round(value * 100) / 100;
/** Room heights are kept to the tenth, as they are matched (src/lib/floorData.ts). */
const tenth = (value) => Math.round(value * 10) / 10;
const empty = (map) => ({ map, samples: [], rooms: [] });

/** Rounds coordinates and orders entries so the file diffs cleanly. */
function tidy(map, data) {
	if (!Array.isArray(data?.samples) || !Array.isArray(data?.rooms)) throw new Error("samples and rooms required");
	const samples = data.samples.map((sample) => ({ ...sample, x: round(sample.x), y: round(sample.y), z: round(sample.z) }))
		.sort((a, b) => a.id.localeCompare(b.id));
	// A room is a box (`rect`) or rings of points (`area`).
	const rooms = data.rooms.map(({ rect, area, ...room }) => ({
		...room,
		...rect ? { rect: { x: round(rect.x), z: round(rect.z), width: round(rect.width), depth: round(rect.depth), angle: round(rect.angle) } } : {},
		...area ? { area: area.map((ring) => ring.map(([x, z]) => [round(x), round(z)])) } : {},
		height: room.height && room.height.map((value) => value === null ? null : tenth(value)),
	})).sort((a, b) => a.id.localeCompare(b.id));
	return { map, samples, rooms };
}

export function floorData() {
	return {
		name: "floor-data",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use("/__dev/floor-data", (request, response) => {
				const map = decodeURIComponent((request.url ?? "").replace(/^\//, "").split("?")[0]);
				if (!/^[a-z0-9-]+$/.test(map)) { response.statusCode = 400; response.end("map key required"); return; }
				const file = new URL(`${map}.json`, dir);
				if (request.method === "GET") {
					readFile(file, "utf8").then((text) => text, () => JSON.stringify(empty(map))).then((text) => {
						response.setHeader("Content-Type", "application/json");
						response.end(text);
					});
					return;
				}
				if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
				let body = "";
				request.on("data", (chunk) => { body += chunk; });
				request.on("end", async () => {
					try {
						await mkdir(dir, { recursive: true });
						await writeFile(file, JSON.stringify(tidy(map, JSON.parse(body)), null, "\t") + "\n");
						response.end("ok");
					} catch (error) {
						response.statusCode = 400;
						response.end(String(error));
					}
				});
			});
		},
	};
}
