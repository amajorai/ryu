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
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5187,
		strictPort: true,
	},
	build: {
		rollupOptions: {
			input: path.resolve(harnessDir, "multi-folder-project-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
