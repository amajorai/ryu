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
	define: {
		"process.env": {},
	},
	optimizeDeps: {
		entries: [
			"./agent-conversation-branch-proof.html",
			"./chat-row-menus-story.html",
			"./chat-row-selection-story.html",
			"./keyboard-shortcuts-search-proof.html",
		],

		esbuildOptions: { target: "esnext" },
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_E2E_PORT ?? "5182"),
		strictPort: true,
	},
});
