import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	build: {
		outDir: path.resolve(harnessDir, "dist-private-team-visibility-proof"),
		rollupOptions: {
			input: path.resolve(harnessDir, "private-team-visibility-story.html"),
		},
	},
	clearScreen: false,
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	plugins: [react()],
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	root: harnessDir,
	server: {
		host: "127.0.0.1",
		port: 5203,
		strictPort: true,
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
