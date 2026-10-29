import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const runtime = path.resolve(
	harnessDir,
	"global-context-menu-proof.runtime.ts"
);

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-global-context-menu-vite-cache`,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["global-context-menu-proof.html"],
		force: true,

		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: [
			{ find: "@/lib/tauri-bridge.ts", replacement: runtime },
			{ find: "@tauri-apps/api/webviewWindow", replacement: runtime },
			{ find: "html2canvas-pro", replacement: runtime },
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
	server: { host: "127.0.0.1", port: 5447, strictPort: true },
});
