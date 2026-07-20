// Standalone Vite config for the plugin-runtime cert harness (`index.html` +
// `main.ts`), isolated from the main desktop app so the cert page builds and serves
// on its own. Playwright's `webServer` runs `vite` with this config; `vite build`
// with it proves the harness compiles here even though headless Chromium cannot
// launch in this environment.
//
// `root` is the harness dir so `index.html` is the entry; the `@` alias mirrors the
// app so `../../src/...` and any `@/...` imports resolve to `apps/desktop`.

import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	root: harnessDir,
	clearScreen: false,
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		port: 5177,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist"),
		target: "chrome105",
		emptyOutDir: true,
	},
});
