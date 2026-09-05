import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: { "process.env": {} },
	root: harnessDir,
	clearScreen: false,
	// The shared harness directory contains many independent story HTML files.
	// Limit dependency scanning to this proof so an unrelated story cannot make
	// this settings test fail through the desktop alias.
	optimizeDeps: {
		entries: ["settings-dialog-shortcuts-proof.html"],
	},
	resolve: {
		alias: { "@": desktopRoot },
	},
	server: {
		host: "127.0.0.1",
		port: 5198,
		strictPort: true,
	},
});
