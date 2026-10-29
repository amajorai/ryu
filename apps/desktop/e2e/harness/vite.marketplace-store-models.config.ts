import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const mockDir = path.resolve(harnessDir, "marketplace-store-mocks");
const serverPort = Number(
	process.env.RYU_MARKETPLACE_STORE_MODELS_PORT ?? 5190
);

export default defineConfig({
	plugins: [
		{
			name: "marketplace-models-active-node-fixture",
			enforce: "pre",
			resolveId(source) {
				if (source === "./useActiveNode.ts") {
					return path.join(mockDir, "active-node.ts");
				}
				return null;
			},
		},
		react(),
	],
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	clearScreen: false,
	resolve: {
		alias: [
			{
				find: "@/lib/auth-client.ts",
				replacement: path.join(mockDir, "auth-client.ts"),
			},
			{
				find: "@/lib/core-url.ts",
				replacement: path.join(mockDir, "core-url.ts"),
			},
			{
				find: "@/src/components/marketplace/host.tsx",
				replacement: path.join(harnessDir, "marketplace-store-test-host.tsx"),
			},
			{
				find: "@/src/components/store/catalog-host.tsx",
				replacement: path.join(mockDir, "catalog-host.tsx"),
			},
			{
				find: "@/src/contexts/TabsContext.tsx",
				replacement: path.join(mockDir, "tabs-context.ts"),
			},
			{
				find: "@/src/hooks/useActiveNode.ts",
				replacement: path.join(mockDir, "active-node.ts"),
			},
			{
				find: "@/src/hooks/usePluginContributions.ts",
				replacement: path.join(mockDir, "plugin-contributions.ts"),
			},
			{
				find: "@/src/hooks/usePluginSettingsOpener.ts",
				replacement: path.join(mockDir, "plugin-settings-opener.ts"),
			},
			{
				find: "@/src/hooks/useStorePrefetch.ts",
				replacement: path.join(mockDir, "store-prefetch.ts"),
			},
			{
				find: "@/src/hooks/useStoreSectionCounts.ts",
				replacement: path.join(mockDir, "store-section-counts.ts"),
			},
			{ find: "@", replacement: desktopRoot },
		],
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: serverPort,
		strictPort: true,
		// A test run must retain its mounted state while parallel coverage work
		// edits this shared checkout. Exercise one loaded version until shutdown.
		watch: null,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-marketplace-store-models"),
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "marketplace-store-models.html"),
		},
	},

	// This root holds every harness page. Scan only this story so a cold start
	// prebundles its own dependency graph, and keep that cache apart from the
	// sibling Store configs that share the root with different mocks.
	cacheDir: path.resolve(
		harnessDir,
		"node_modules/.vite-marketplace-store-models"
	),
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: [path.resolve(harnessDir, "marketplace-store-models.html")],
	},
});
