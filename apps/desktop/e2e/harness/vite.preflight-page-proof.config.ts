import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const mockModule = path.resolve(harnessDir, "preflight-page-proof.mock.ts");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-preflight-page-vite-cache-v3`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["preflight-page-proof.html"],
		force: true,

		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: [
			{ find: "@/lib/tauri-bridge.ts", replacement: mockModule },
			{ find: "@/src/lib/tauri-ready.ts", replacement: mockModule },
			{ find: "../tauri-ready.ts", replacement: mockModule },
			{ find: "./tauri-ready.ts", replacement: mockModule },
			{ find: "@/src/lib/analytics.ts", replacement: mockModule },
			{ find: "@/src/lib/crash.ts", replacement: mockModule },
			{ find: "@tauri-apps/api/app", replacement: mockModule },
			{ find: "@tauri-apps/api/core", replacement: mockModule },
			{ find: "@tauri-apps/plugin-process", replacement: mockModule },
			{
				find: "lucide-react",
				replacement: path.resolve(
					desktopRoot,
					"node_modules/lucide-react/dist/cjs/lucide-react.js"
				),
			},
			{ find: "@", replacement: desktopRoot },
			{
				find: "react",
				replacement: path.resolve(desktopRoot, "node_modules/react"),
			},
			{
				find: "react-dom",
				replacement: path.resolve(desktopRoot, "node_modules/react-dom"),
			},
		],
	},
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5301, strictPort: true },
});
