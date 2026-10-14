// Dev server only: the map's document linker (src/components/DocumentLinker.tsx) POSTs here and it lands in src/maps/documents.
// links.json: `{ id, position }` sets a link (position null rejects a location, undefined drops the link; its `floor` is kept),
// `{ id, floor }` sets or (null) clears the floor of an existing link. locked.json: `{ id, locked }` sets whether a location is
// behind a lock, or (null) goes back to what tarkovdoc says. HMR picks both up.
import { readFile, writeFile } from "node:fs/promises";

const linksFile = new URL("../src/maps/documents/links.json", import.meta.url);
const lockedFile = new URL("../src/maps/documents/locked.json", import.meta.url);
const round = (value) => Math.round(value * 100) / 100;

async function update(file, change) {
	const data = JSON.parse(await readFile(file, "utf8"));
	change(data);
	const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
	await writeFile(file, JSON.stringify(sorted, null, "\t") + "\n");
}

function linkChange({ id, position, floor }) {
	return (links) => {
		if (floor !== undefined) {
			const link = links[id];
			if (!link) throw new Error("a floor needs a link");
			if (floor) link.floor = floor;
			else delete link.floor;
		} else if (position === undefined) delete links[id];
		// A floor set by hand on the link stays with it when it moves.
		else links[id] = position && { x: round(position.x), ...position.y === undefined ? {} : { y: round(position.y) }, z: round(position.z), ...links[id]?.floor ? { floor: links[id].floor } : {} };
	};
}

const lockedChange = ({ locked, id }) => (all) => {
	if (typeof locked === "boolean") all[id] = locked;
	else delete all[id];
};

function route(server, path, file, change) {
	server.middlewares.use(path, (request, response) => {
		if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", async () => {
			try {
				const message = JSON.parse(body);
				if (typeof message.id !== "string") throw new Error("id required");
				await update(file, change(message));
				response.end("ok");
			} catch (error) {
				response.statusCode = 400;
				response.end(String(error));
			}
		});
	});
}

export function documentLinks() {
	return {
		name: "document-links",
		apply: "serve",
		configureServer(server) {
			route(server, "/__dev/document-links", linksFile, linkChange);
			route(server, "/__dev/document-locked", lockedFile, lockedChange);
		},
	};
}
