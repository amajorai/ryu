import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	define: {
		"process.env": {},
	},
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite-worktree-settings-proof"
	),
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["worktree-settings-proof.html"],
	},
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5218,
		strictPort: true,
	},
});
