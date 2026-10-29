import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { catalogPerformanceApi } from "./catalog-performance-api.ts";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react(), catalogPerformanceApi()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite-catalog-performance" +
			(process.env.RYU_PERF_BASELINE ? "-baseline" : "")
	),
	optimizeDeps: {
		entries: ["catalog-performance-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	clearScreen: false,
	define: { "process.env": {} },
	resolve: {
		alias: {
			...(process.env.RYU_PERF_BASELINE
				? {
						"@/src/hooks/useAgents.ts": "/tmp/ryu-perf-baseline/useAgents.ts",
						"@/src/hooks/useApps.ts": "/tmp/ryu-perf-baseline/useApps.ts",
					}
				: undefined),
			"@": desktopRoot,
		},
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5204,
		strictPort: true,
		watch: null,
		hmr: false,
		fs: {
			allow: [path.resolve(desktopRoot, "../.."), "/tmp/ryu-perf-baseline"],
		},
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-catalog-performance-proof"),
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "catalog-performance-proof.html"),
		},
	},
});
