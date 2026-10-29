import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
	},
	root: harnessDir,
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite/markdown-streaming-proof"
	),
	clearScreen: false,
	optimizeDeps: {
		entries: [path.resolve(harnessDir, "markdown-streaming-proof.html")],
	},
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	// A timed proof run must not be reloaded midway by edits elsewhere in the
	// shared tree; restart the server to pick up changes instead.
	server: {
		// Enables the JS Self-Profiling API (`new Profiler(...)`) on the page, so
		// a run can report where main-thread time goes by function.
		headers: { "Document-Policy": "js-profiling" },
		hmr: false,
		port: 5189,
		strictPort: true,
		watch: { ignored: ["**/*"] },
	},
});
