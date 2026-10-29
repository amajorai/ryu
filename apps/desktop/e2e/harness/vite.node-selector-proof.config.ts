import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const tauriMock = path.resolve(harnessDir, "node-selector-proof.mock.ts");
const hookMock = path.resolve(harnessDir, "node-selector-hooks.mock.ts");
const activeNodeMock = path.resolve(
	harnessDir,
	"node-selector-active-node.mock.ts"
);

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-node-selector-vite-cache`,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["node-selector-proof.html"],
		force: true,

		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: [
			{ find: "@/src/hooks/useActiveNode.ts", replacement: activeNodeMock },
			{ find: "@/src/hooks/useCreditsWallet.ts", replacement: hookMock },
			{ find: "@/src/hooks/useOrgBillingStatus.ts", replacement: hookMock },
			{ find: "@/lib/tauri-bridge.ts", replacement: tauriMock },
			{ find: "@tauri-apps/api/core", replacement: tauriMock },
			{ find: "@tauri-apps/api/event", replacement: tauriMock },
			{ find: "@tauri-apps/plugin-dialog", replacement: tauriMock },
			{ find: "@tauri-apps/plugin-process", replacement: tauriMock },
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
	server: { host: "127.0.0.1", port: 5411, strictPort: true },
});
