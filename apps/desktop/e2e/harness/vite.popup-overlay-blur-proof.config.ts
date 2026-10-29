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
		port: 5181,
		strictPort: true,
	},
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-popup-overlay-blur-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "popup-overlay-blur-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
