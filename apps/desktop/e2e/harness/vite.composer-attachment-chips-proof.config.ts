import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

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
	server: {
		port: 5185,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-composer-attachment-chips-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "composer-attachment-chips-proof.html"),
		},
	},
});
