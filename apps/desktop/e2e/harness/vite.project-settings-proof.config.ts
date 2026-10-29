import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const mockModule = path.resolve(harnessDir, "project-settings-proof.mock.ts");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-project-settings-vite-cache`,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["project-settings-proof.html"],
		force: true,
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: [
			{ find: "@/src/hooks/useActiveNode.ts", replacement: mockModule },
			{ find: "@tauri-apps/api/core", replacement: mockModule },
			{ find: "@tauri-apps/api/event", replacement: mockModule },
			{ find: "@tauri-apps/plugin-dialog", replacement: mockModule },
			{ find: "@tauri-apps/plugin-process", replacement: mockModule },
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
	server: {
		host: "127.0.0.1",
		port: 5398,
		strictPort: true,
		// A test run must retain its mounted state while parallel coverage work
		// edits this shared checkout: any write under this harness root reloads
		// the page mid-test. Exercise one loaded version until shutdown.
		watch: null,
	},
});
