// Autopilot Companion proof server: the shared harness config with its own
// dependency cache. Other desktop proofs start Vite dev servers from this
// package at the same time, and a shared `node_modules/.vite` lets one server's
// dependency re-optimization replace files another server's page is still
// loading, which stalls that page's first navigation until the test times out.
// The cache stays under `node_modules` so the React plugin keeps skipping Babel
// on the prebundled dependencies.

import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.harness.config.ts";

export default mergeConfig(
	base,
	defineConfig({
		cacheDir: path.resolve(
			import.meta.dirname,
			"../../node_modules/.vite-autopilot-companion-proof"
		),
		optimizeDeps: {
			entries: [
				path.resolve(import.meta.dirname, "autopilot-companion-proof.html"),
			],
		},
	})
);
