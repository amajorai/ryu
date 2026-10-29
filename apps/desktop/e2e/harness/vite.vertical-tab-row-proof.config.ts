import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-vertical-tab-row-vite-cache`,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["vertical-tab-row-proof.html"],
		force: true,
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: [
			{
				find: "@/src/contexts/ChatHistoryContext.tsx",
				replacement: path.resolve(
					harnessDir,
					"vertical-tab-row-chat-history.mock.tsx"
				),
			},
			{
				find: "@/src/contexts/entitlement-context.tsx",
				replacement: path.resolve(
					harnessDir,
					"vertical-tab-row-entitlement.mock.tsx"
				),
			},
			{
				find: "@/src/hooks/usePluginContributions.ts",
				replacement: path.resolve(
					harnessDir,
					"vertical-tab-row-plugins.mock.ts"
				),
			},
			{
				find: "@/src/lib/tauri-ready.ts",
				replacement: path.resolve(harnessDir, "vertical-tab-row-tauri.mock.ts"),
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
	server: { host: "127.0.0.1", port: 5442, strictPort: true, watch: null },
});
