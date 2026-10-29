import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	build: {
		outDir: path.resolve(harnessDir, "dist-managed-openrouter-routing-proof"),
		target: "chrome105",
	},
	clearScreen: false,
	define: {
		"process.env": {},
		process: JSON.stringify({ env: {} }),
	},
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	plugins: [react()],
	optimizeDeps: {
		entries: [
			path.resolve(harnessDir, "managed-openrouter-routing-proof.html"),
		],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: {
			"@": path.resolve(harnessDir, "../.."),
		},
	},
	root: harnessDir,
	server: {
		port: 5179,
		strictPort: true,
	},
});
