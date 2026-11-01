import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

/** Isolated build for the ACP runtime proof; unrelated stories stay out of its graph. */
export default defineConfig({
	plugins: [react()],
	cacheDir: path.join(tmpdir(), "ryu-acp-runtime-settings-proof-vite-cache"),
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	build: {
		outDir: path.join(tmpdir(), "ryu-acp-runtime-settings-proof-build"),
		emptyOutDir: true,
		// Match the desktop webview target (vite.config.ts): esbuild cannot lower
		// dependency destructuring to Vite's default es2020 browser targets.
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "acp-runtime-settings-proof.html"),
		},
	},
	preview: {
		port: 5178,
		strictPort: true,
	},
});
