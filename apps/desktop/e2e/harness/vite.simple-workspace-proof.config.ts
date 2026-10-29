import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const proofHtml = path.resolve(harnessDir, "simple-workspace-proof.html");

export default defineConfig({
	build: {
		outDir: path.resolve(harnessDir, "dist-simple-workspace-proof"),
		rollupOptions: {
			input: proofHtml,
		},
	},
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5197,
		strictPort: true,
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
