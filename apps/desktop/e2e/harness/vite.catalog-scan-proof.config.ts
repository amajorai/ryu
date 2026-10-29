import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

/** Isolated build for the catalog scan proof; unrelated stories stay out of its graph. */
export default defineConfig({
	plugins: [react()],
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
		outDir: path.resolve(harnessDir, "dist-catalog-scan-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "catalog-scan-proof.html"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5197,
		strictPort: true,
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
