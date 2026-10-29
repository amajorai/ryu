import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	cacheDir:
		"C:/Users/jiawei/Documents/Codex/2026-09-30/continue/.tmp/vite-gemini-routing-live",
	optimizeDeps: { entries: ["gemini-routing-live-proof.html"] },
	resolve: { alias: [{ find: "@", replacement: desktopRoot }] },
	server: {
		host: "127.0.0.1",
		port: 5209,
		strictPort: true,
		proxy: {
			"/api/gateway/config": "http://127.0.0.1:54602",
			"/__gemini": "http://127.0.0.1:54602",
		},
	},
});
