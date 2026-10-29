import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite-chat-performance" +
			(process.env.RYU_PERF_BASELINE ? "-baseline" : "")
	),
	publicDir: path.resolve(desktopRoot, "public"),
	define: { "process.env": {} },
	optimizeDeps: {
		entries: [
			"chat-scroll-story.html",
			"chat-grouping-story.html",
			"chat-search-story.html",
		],

		esbuildOptions: { target: "esnext" },
	},
	clearScreen: false,
	resolve: {
		alias: {
			"@": desktopRoot,
		},
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5205,
		strictPort: true,
		watch: null,
		hmr: false,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-chat-scroll-story"),
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "chat-scroll-story.html"),
		},
	},
});
