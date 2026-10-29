import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

/** Isolated build for the actual file-tree actions proof; unrelated stories stay out of its graph. */
export default defineConfig({
	plugins: [react()],
	cacheDir: path.join(tmpdir(), "ryu-file-tree-actions-proof-vite-cache"),
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
		// The actual Chromium proof supports its asynchronous bootstrap.
		target: "esnext",
		outDir: path.join(tmpdir(), "ryu-file-tree-actions-proof-build"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "file-tree-actions-proof.html"),
		},
	},
	preview: {
		port: 5781,
		strictPort: true,
	},
});
