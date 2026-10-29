import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	build: {
		outDir: path.resolve(harnessDir, "media-lightbox-proof-dist"),
		rollupOptions: {
			input: path.resolve(harnessDir, "media-pip-lightbox-proof.html"),
		},
	},
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
	},
	plugins: [react()],
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	root: harnessDir,

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
