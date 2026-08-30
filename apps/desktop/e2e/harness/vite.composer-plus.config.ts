// Focused Vite config for the composer-plus browser proof. The full harness
// config intentionally builds many stories, including unrelated experimental
// pages; this proof only needs the shared InputBar story and should not inherit
// another story's parse failure or cold-start cost.

import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	optimizeDeps: {
		entries: [path.resolve(harnessDir, "composer-plus-story.html")],
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_E2E_PORT ?? "5178"),
		strictPort: true,
	},
});
