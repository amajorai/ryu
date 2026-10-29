import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root: harnessDir,
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite-dashboard-canvas-proof"
	),
	publicDir: path.resolve(desktopRoot, "public"),
	optimizeDeps: {
		entries: ["dashboard-canvas-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: { host: "127.0.0.1", port: 5267, strictPort: true },
});
