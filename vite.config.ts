import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { documentLinks } from "./scripts/document-links-plugin.mjs";
import { floorData } from "./scripts/floor-data-plugin.mjs";

export default defineConfig({
	plugins: [react(), documentLinks(), floorData()],
	server: {
		host: "127.0.0.1",
		port: 1420,
		strictPort: true,
		watch: { ignored: ["**/src-tauri/**", "**/.local/**"] },
	},
	// Emit every asset as a file: inlined `data:` URLs are blocked by the Tauri CSP's img-src.
	build: { assetsInlineLimit: 0 },
	clearScreen: false,
});
