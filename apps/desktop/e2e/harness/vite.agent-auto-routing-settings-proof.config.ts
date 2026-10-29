import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const tauriMock = path.resolve(harnessDir, "node-selector-proof.mock.ts");
const hookMock = path.resolve(harnessDir, "node-selector-hooks.mock.ts");
const composerHookMock = path.resolve(
	harnessDir,
	"agent-auto-routing-settings-proof.hooks.tsx"
);
const activeNodeMock = path.resolve(
	harnessDir,
	"node-selector-active-node.mock.ts"
);

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-agent-auto-routing-settings-vite-cache`,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["node-selector-proof.html"],
		force: true,
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: [
			{ find: "@/src/hooks/useActiveNode.ts", replacement: activeNodeMock },
			{ find: "@/src/hooks/useCreditsWallet.ts", replacement: hookMock },
			{ find: "@/src/hooks/useOrgBillingStatus.ts", replacement: hookMock },
			{
				find: "@/src/hooks/useAgentCapabilities.ts",
				replacement: composerHookMock,
			},
			{
				find: "@/src/hooks/usePiConfig.ts",
				replacement: composerHookMock,
			},
			{
				find: "@/src/hooks/useRoutingAdvice.ts",
				replacement: composerHookMock,
			},
			{
				find: "@/src/hooks/useInterfaceLevel.ts",
				replacement: composerHookMock,
			},
			{
				find: "@/src/hooks/useAgentUsage.ts",
				replacement: composerHookMock,
			},
			{
				find: "@/components/agent-elements/input/use-universal-picker.ts",
				replacement: composerHookMock,
			},
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
	server: { host: "127.0.0.1", port: 5421, strictPort: true },
});
