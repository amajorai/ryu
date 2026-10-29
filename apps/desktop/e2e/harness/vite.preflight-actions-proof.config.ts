import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const desktop = path.resolve(root, "../..");
const boundary = path.resolve(root, "preflight-proof-boundaries.ts");
export default defineConfig({
	root,
	optimizeDeps: {
		entries: [path.resolve(root, "preflight-actions-proof.html")],

		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: {
		"import.meta.env.VITE_SENTRY_DSN": JSON.stringify(
			"https://proof@example.invalid/1"
		),
	},
	resolve: {
		alias: [
			...[
				"@tauri-apps/api/app",
				"@sentry/react",
				"@/src/lib/analytics.ts",
				"@/src/lib/api/system.ts",
				"@/src/lib/api/update.ts",
				"@/src/lib/console-buffer.ts",
				"@/src/lib/dev-metrics.ts",
				"@/src/lib/services-api.ts",
			].map((find) => ({ find, replacement: boundary })),
			{ find: "@", replacement: desktop },
		],
	},
	server: { host: "127.0.0.1", port: 5217, strictPort: true },
});
