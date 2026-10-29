import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const mockModule = path.resolve(
	harnessDir,
	"gateway-project-environments-proof.mock.ts"
);

export default defineConfig({
	plugins: [react()],
	base: "./",
	cacheDir: `${tmpdir()}/ryu-gateway-project-environments-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["gateway-project-environments-proof.html"],
		force: true,

		esbuildOptions: { target: "esnext" },
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	resolve: {
		dedupe: ["react", "react-dom"],
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
	server: {
		host: "127.0.0.1",
		port: 5252,
		strictPort: true,
		// A test run must retain its mounted state while parallel coverage work
		// edits this shared checkout: any write under this harness root reloads
		// the page mid-test. Exercise one loaded version until shutdown.
		watch: null,
	},
});
