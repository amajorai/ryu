import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const mockModule = path.resolve(
	harnessDir,
	"desktop-danger-zone-proof.mock.ts"
);

export default defineConfig({
	plugins: [react()],
	base: "./",
	cacheDir: `${tmpdir()}/ryu-desktop-danger-zone-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["desktop-danger-zone-proof.html"],
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
			{ find: "@/src/store/useNodeStore.ts", replacement: mockModule },
			{ find: "@/lib/tauri-bridge.ts", replacement: mockModule },
			{ find: "@tauri-apps/api/core", replacement: mockModule },
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
		port: 5255,
		strictPort: true,
	},
});
