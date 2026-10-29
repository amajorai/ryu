import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = import.meta.dirname;
export default defineConfig({
	base: "./",
	cacheDir: path.resolve(
		harnessDir,
		"../../../../tmp/reviews-proof-vite-cache"
	),
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	plugins: [react()],
	optimizeDeps: {
		entries: [path.resolve(harnessDir, "reviews-state-proof.html")],

		esbuildOptions: { target: "esnext" },
	},
	resolve: { alias: { "@": path.resolve(harnessDir, "../..") } },
	root: harnessDir,
	build: {
		emptyOutDir: true,
		outDir: path.resolve(harnessDir, "../../../../tmp/ryu-reviews-state-proof"),
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "reviews-state-proof.html"),
		},
	},
});
