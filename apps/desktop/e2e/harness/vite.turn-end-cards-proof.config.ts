import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	server: {
		host: "127.0.0.1",
		hmr: false,
		port: 5182,
		strictPort: true,
		watch: {
			// This focused proof runs in a shared checkout where unrelated tasks may
			// be editing other harness files. Do not reload the page underneath
			// Playwright while it verifies this immutable fixture.
			ignored: ["**/*"],
		},
	},
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-turn-end-cards-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "turn-end-cards-proof-story.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
