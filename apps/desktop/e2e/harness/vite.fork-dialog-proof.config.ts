import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	optimizeDeps: {
		entries: ["fork-dialog-proof.html"],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: {
			"@": path.resolve(harnessDir, "../.."),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5196,
		strictPort: true,
	},
});
