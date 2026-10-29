import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const mockModule = path.resolve(
	harnessDir,
	"gateway-evals-health-proof.mock.ts"
);

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-gateway-evals-health-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["gateway-evals-health-proof.html"],
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
			{
				find: "@/src/components/updater/AutoUpdater.tsx",
				replacement: mockModule,
			},
			{ find: "@tauri-apps/api/app", replacement: mockModule },
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
	server: { host: "127.0.0.1", port: 5298, strictPort: true },
});
