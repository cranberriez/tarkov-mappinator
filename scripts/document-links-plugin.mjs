// Dev server only: the map's document linker (src/components/DocumentLinker.tsx) POSTs `{ id, position }` here and it
// lands in src/maps/documents/links.json (position null rejects a location, undefined drops the link; a hand-added `floor` is kept). HMR picks it up.
import { readFile, writeFile } from "node:fs/promises";

const file = new URL("../src/maps/documents/links.json", import.meta.url);
const round = (value) => Math.round(value * 100) / 100;

export function documentLinks() {
	return {
		name: "document-links",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use("/__dev/document-links", (request, response) => {
				if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
				let body = "";
				request.on("data", (chunk) => { body += chunk; });
				request.on("end", async () => {
					try {
						const { id, position } = JSON.parse(body);
						if (typeof id !== "string") throw new Error("id required");
						const links = JSON.parse(await readFile(file, "utf8"));
						if (position === undefined) delete links[id];
						// A floor set by hand on the link stays with it when it moves.
						else links[id] = position && { x: round(position.x), ...position.y === undefined ? {} : { y: round(position.y) }, z: round(position.z), ...links[id]?.floor ? { floor: links[id].floor } : {} };
						const sorted = Object.fromEntries(Object.entries(links).sort(([a], [b]) => a.localeCompare(b)));
						await writeFile(file, JSON.stringify(sorted, null, "\t") + "\n");
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
