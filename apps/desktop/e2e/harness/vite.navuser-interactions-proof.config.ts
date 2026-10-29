import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const contexts = path.resolve(
	harnessDir,
	"navuser-interactions-proof.contexts.tsx"
);
const hooks = path.resolve(harnessDir, "navuser-interactions-proof.hooks.tsx");
const runtime = path.resolve(
	harnessDir,
	"navuser-interactions-proof.runtime.ts"
);

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-navuser-interactions-vite-cache`,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: {
		"process.env": {},
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(
			"http://127.0.0.1:5431"
		),
		"import.meta.env.VITE_APP_FRONTEND_URL": JSON.stringify(
			"http://localhost:3001"
		),
		"import.meta.env.VITE_CORE_URL": JSON.stringify("http://127.0.0.1:5431"),
	},
	optimizeDeps: {
		entries: ["navuser-interactions-proof.html"],
		force: true,

		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: [
			{ find: "@/src/contexts/entitlement-context.tsx", replacement: contexts },
			{ find: "@/src/contexts/TabsContext.tsx", replacement: contexts },
			{ find: "@/src/contexts/SpacesContext.tsx", replacement: contexts },
			{ find: "@/src/hooks/useCreditsWallet.ts", replacement: hooks },
			{ find: "@/src/hooks/useOrgBillingStatus.ts", replacement: hooks },
			{ find: "@/src/hooks/useRecentUpdates.ts", replacement: hooks },
			{ find: "@/src/hooks/useApprovals.ts", replacement: hooks },
			{ find: "@/src/hooks/useQuests.ts", replacement: hooks },
			{ find: "@/src/hooks/useNotifications.ts", replacement: hooks },
			{ find: "@/src/hooks/useAnnouncements.ts", replacement: hooks },
			{ find: "@/src/hooks/useSystemAnnouncements.ts", replacement: hooks },
			{ find: "@/src/hooks/useAppsCatalog.ts", replacement: hooks },
			{ find: "@/src/hooks/useAvailableUpdates.ts", replacement: hooks },
			{ find: "@/src/hooks/useDownloadBulkActions.ts", replacement: hooks },
			{ find: "@/src/lib/tauri-ready.ts", replacement: runtime },
			{ find: "@/lib/tauri-bridge.ts", replacement: runtime },
			{ find: "@tauri-apps/api/core", replacement: runtime },
			{ find: "@tauri-apps/api/event", replacement: runtime },
			{ find: "@tauri-apps/api/app", replacement: runtime },
			{ find: "@tauri-apps/plugin-store", replacement: runtime },
			{ find: "@tauri-apps/plugin-dialog", replacement: runtime },
			{ find: "@tauri-apps/plugin-process", replacement: runtime },
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
	server: { host: "127.0.0.1", port: 5431, strictPort: true },
});
