import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const mock = path.resolve(
	import.meta.dirname,
	"library-engine-settings-mocks.ts"
);

export default defineConfig({
	root: import.meta.dirname,
	// Different proof configs share this root but use different mocks. Keep
	// their optimized dependency caches from invalidating a mounted Library.
	cacheDir: path.resolve(
		import.meta.dirname,
		"node_modules/.vite-library-engine-settings"
	),
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: [
			path.resolve(import.meta.dirname, "library-engine-settings.html"),
		],
	},
	build: {
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "library-engine-settings.html"),
		},
	},
	plugins: [
		{
			name: "library-engine-active-node",
			enforce: "pre",
			resolveId(source) {
				return source === "./useActiveNode.ts" ? mock : null;
			},
		},
		react(),
	],
	css: { postcss: { plugins: [tailwindcss()] } },
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			...[
				"@/lib/auth-client.ts",
				"@/lib/core-url.ts",
				"@/src/contexts/entitlement-context.tsx",
				"@/src/contexts/TabsContext.tsx",
				"@/src/contexts/SpacesContext.tsx",
				"@/src/contexts/ChatHistoryContext.tsx",
				"@/src/hooks/usePluginContributions.ts",
				"@/src/hooks/useActiveNode.ts",
				"@/src/hooks/usePluginSettingsOpener.ts",
			].map((find) => ({ find, replacement: mock })),
			{ find: "@", replacement: path.resolve(import.meta.dirname, "../..") },
		],
	},
	server: {
		host: "127.0.0.1",
		port: 5192,
		strictPort: true,
		// A test run must retain its mounted state while parallel coverage work
		// edits this shared checkout. Exercise one loaded version until shutdown.
		watch: null,
	},
});
