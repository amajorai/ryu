import { tmpdir } from "node:os";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import original from "./vite.marketplace-store-catalogs.config.ts";

// Keep transport/auth/navigation seams; run the actual contributions, prefetch,
// count and settings-opener hooks for the StorePage integration case.
const productionHooks = new Set([
	"@/src/hooks/usePluginContributions.ts",
	"@/src/hooks/useStorePrefetch.ts",
	"@/src/hooks/useStoreSectionCounts.ts",
	"@/src/hooks/usePluginSettingsOpener.ts",
	"@/lib/core-url.ts",
]);
export default defineConfig({
	...original,
	cacheDir: `${tmpdir()}/ryu-store-sources-contributed-vite`,
	// Scan this story rather than the inherited catalogs build entry. The cache
	// lives outside node_modules, so explicitly exclude its already-built modules
	// from React/Babel transforms as well.
	optimizeDeps: {
		entries: ["marketplace-store-sources-contributed.html"],
		esbuildOptions: { target: "esnext" },
	},
	plugins: [
		original.plugins?.[0],
		react({
			exclude: [
				/\/node_modules\//,
				/\/ryu-store-sources-contributed-vite\/deps\//,
			],
		}),
	],
	resolve: {
		...original.resolve,
		alias: [
			{
				find: "@/lib/core-url.ts",
				replacement: path.resolve(
					import.meta.dirname,
					"marketplace-store-sources-core-url.ts"
				),
			},
			...(Array.isArray(original.resolve?.alias)
				? original.resolve.alias
				: []
			).filter((alias) => !productionHooks.has(String(alias.find))),
		],
	},
	server: {
		host: "127.0.0.1",
		port: 5493,
		strictPort: true,
		watch: {
			ignored: [
				path.resolve(
					import.meta.dirname,
					"../test-results-store-sources-contributed/**"
				),
			],
		},
	},
});
