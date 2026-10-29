import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const mockModule = path.resolve(
	harnessDir,
	"gateway-storage-settings-proof.mock.ts"
);

export default defineConfig({
	plugins: [react()],
	base: "./",
	cacheDir: `${tmpdir()}/ryu-gateway-storage-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["gateway-storage-settings-proof.html"],
		force: true,
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
		// This proof exercises one launched source snapshot, not Vite hot reload.
		watch: null,
		host: "127.0.0.1",
		port: 5247,
		strictPort: true,
	},
});
