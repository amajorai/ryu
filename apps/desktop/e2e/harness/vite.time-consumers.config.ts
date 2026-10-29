import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import canonical from "./vite.time-dates.config.ts";

const directory = process.env.RYU_TIME_CONSUMERS_DIST;
if (!(directory && path.isAbsolute(directory))) {
	throw new Error("An absolute owned RYU_TIME_CONSUMERS_DIST is required");
}
// Same authentic React/resolver/installed icon exports/CSS/default minifier.
// Maps observe original resource owners; no load or business replacement.
export default defineConfig(
	mergeConfig(canonical, {
		optimizeDeps: { entries: ["time-consumers-proof.html"] },
		build: {
			outDir: directory,
			emptyOutDir: true,
			sourcemap: true,
			rollupOptions: {
				input: path.resolve(import.meta.dirname, "time-consumers-proof.html"),
			},
		},
	})
);
