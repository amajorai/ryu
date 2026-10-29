import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: { "process.env": {} },
	root: harnessDir,
	clearScreen: false,
	optimizeDeps: {
		entries: ["appearance-transparency-proof.html"],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: { "@": desktopRoot },
	},
	server: {
		host: "127.0.0.1",
		port: 5199,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-appearance-transparency-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "appearance-transparency-proof.html"),
		},
	},
});
