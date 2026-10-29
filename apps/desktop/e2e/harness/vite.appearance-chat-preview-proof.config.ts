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
	root: harnessDir,
	clearScreen: false,
	server: {
		host: "127.0.0.1",
		port: 5180,
		strictPort: true,
	},
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-appearance-chat-preview-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "appearance-chat-preview-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
