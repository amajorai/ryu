// Vite config for the thread hierarchy bar story alone, so its spec does not
// wait for the shared harness to scan every other story's dependencies.
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
export default defineConfig({
	plugins: [react()],
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	resolve: { dedupe: ["react", "react-dom"], alias: { "@": desktopRoot } },
	// Match the desktop webview target (vite.config.ts): esbuild cannot lower
	// dependency destructuring to Vite's default es2020 browser targets.
	optimizeDeps: {
		entries: ["thread-hierarchy-story.html"],
		esbuildOptions: { target: "chrome105" },
	},
	cacheDir: path.resolve(harnessDir, ".vite-thread-hierarchy-story"),
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_THREAD_HIERARCHY_PORT ?? "5683"),
		strictPort: true,
	},
	build: {
		target: "chrome105",
		outDir: path.resolve(harnessDir, "dist-thread-hierarchy-story"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "thread-hierarchy-story.html"),
		},
	},
});
