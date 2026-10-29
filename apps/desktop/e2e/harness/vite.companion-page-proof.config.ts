import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const desktop = path.resolve(root, "../..");
const mock = path.resolve(root, "companion-page-proof.mock.ts");
export default defineConfig({
	root,
	publicDir: path.resolve(desktop, "public"),
	cacheDir: `${tmpdir()}/ryu-companion-app-vite`,
	plugins: [react({ exclude: [/node_modules/, /ryu-companion-app-vite/] })],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["companion-page-proof.html"],
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			...[
				"./components/layout/Layout.tsx",
				"./components/bot/BotManagedEntry.tsx",
				"./components/shell/GlobalContextMenu.tsx",
				"./components/startup/DesktopStartupChooser.tsx",
				"./components/media/MediaPip.tsx",
				"./components/AgentationToolbar.tsx",
				"./pages/HostedStandaloneAppEntry.tsx",
				"./pages/LoginPage.tsx",
				"./pages/OnboardingPage.tsx",
				"./pages/StandaloneAppEntry.tsx",
				"./pages/WaitlistPage.tsx",
			].map((find) => ({
				find,
				replacement: path.resolve(
					root,
					"companion-page-inactive-surfaces.fixture.tsx"
				),
			})),
			...[
				"@/src/hooks/useActiveNode.ts",
				"@/src/hooks/useEntitlement.ts",
				"@/lib/core-url.ts",
				"@tauri-apps/plugin-store",
			].map((find) => ({ find, replacement: mock })),
			{ find: "@", replacement: desktop },
			{
				find: "react",
				replacement: path.resolve(desktop, "node_modules/react"),
			},
			{
				find: "react-dom",
				replacement: path.resolve(desktop, "node_modules/react-dom"),
			},
		],
	},
	server: { host: "127.0.0.1", port: 58_443, strictPort: true },
});
