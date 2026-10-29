import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	plugins: [react()],
	base: "./",
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	build: {
		outDir: path.resolve(harnessDir, "dist-node-lifecycle-capability-proof"),
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "node-lifecycle-capability-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
