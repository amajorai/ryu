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
	base: "./",
	clearScreen: false,
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5182,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-voice-island-mode-proof"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "voice-island-mode-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
