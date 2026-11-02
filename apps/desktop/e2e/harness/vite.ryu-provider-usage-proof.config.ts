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
	// The real provider picker imports a small Next navigation adapter. The proof
	// runs under Vite, so provide the compile-time env object that adapter expects.
	define: {
		"process.env": {},
	},
	root: harnessDir,
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite/ryu-provider-usage-proof"
	),
	clearScreen: false,
	optimizeDeps: {
		entries: [path.resolve(harnessDir, "ryu-provider-usage-proof.html")],
		// Pre-bundle for the dev browser: the default target cannot lower the
		// async destructuring in @tauri-apps/plugin-store, so dep optimization
		// fails and the page never mounts (as the other harnesses set).
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		port: 5178,
		strictPort: true,
	},
});
