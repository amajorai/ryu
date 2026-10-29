import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	optimizeDeps: { esbuildOptions: { target: "esnext" } },
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
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5178,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-tabs-layout-proof"),
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "tabs-layout-proof.html"),
		},
	},
});
