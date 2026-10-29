import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const bridge = path.resolve(root, "marketplace-detail-proof.bridge.tsx");
const baseURL = "http://127.0.0.1:5336";
export default defineConfig({
	root,
	cacheDir: `${tmpdir()}/ryu-marketplace-detail-vite-cache`,
	plugins: [react()],
	optimizeDeps: {
		entries: ["marketplace-detail-proof.html"],
		// Match Desktop's Chromium target for the real account menu dependency graph.
		esbuildOptions: { target: "esnext" },
	},
	build: { target: "chrome105" },
	css: { postcss: { plugins: [tailwindcss()] } },
	define: {
		"process.env": {},
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(baseURL),
		"import.meta.env.VITE_AUTH_CORE_URL": JSON.stringify(baseURL),
		"import.meta.env.VITE_CORE_URL": JSON.stringify(baseURL),
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			...[
				"@/src/components/marketplace/host.tsx",
				"@/src/components/store/catalog-host.tsx",
				"@/src/hooks/useStorePrefetch.ts",
				"@/src/hooks/useStoreSectionCounts.ts",
				"@/src/hooks/useContributedStoreTabs.ts",
				"@/src/hooks/useStoreViewMode.ts",
			].map((find) => ({ find, replacement: bridge })),
			{ find: "@", replacement: path.resolve(root, "../..") },
		],
	},
	server: { hmr: false, host: "127.0.0.1", port: 5336, strictPort: true },
});
