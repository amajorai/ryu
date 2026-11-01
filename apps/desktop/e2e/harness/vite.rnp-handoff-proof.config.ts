import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	plugins: [react()],
	build: {
		// The desktop webview target (vite.config.ts): the locked esbuild cannot
		// lower dependency destructuring to Vite's default es2020 build targets.
		target: "chrome105",
		outDir: path.resolve(harnessDir, "dist-rnp-handoff"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "rnp-handoff-proof.html"),
		},
	},
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	optimizeDeps: {
		entries: ["rnp-handoff-proof.html"],
	},
	resolve: {
		alias: {
			"@": path.resolve(harnessDir, "../.."),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5197,
		strictPort: true,
	},
});
