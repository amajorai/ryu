import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { unifyFramerMotion } from "./vite-framer-motion.ts";

// Keep individual icon modules available to Rollup. The package production
// entry is flattened into one module, which ties lazy-only icons to startup.
const modularIcons = path.join(
	path.dirname(
		fileURLToPath(
			import.meta.resolve("@hugeicons/core-free-icons/package.json")
		)
	),
	"dist/esm/index.js"
);

// A standalone build (scripts/standalone.mjs) passes the app bundle it embeds;
// its display name comes from that bundle's manifest name, like the window title.
function standaloneAppName(): string {
	const bundlePath = process.env.RYU_STANDALONE_APP_BUNDLE?.trim();
	if (!bundlePath) {
		return "";
	}
	const bundle: unknown = JSON.parse(readFileSync(bundlePath, "utf8"));
	const name =
		bundle && typeof bundle === "object" && "appName" in bundle
			? bundle.appName
			: undefined;
	return (typeof name === "string" ? name.trim() : "") || "Ryu App";
}

export default defineConfig({
	plugins: [react(), unifyFramerMotion()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	clearScreen: false,
	// The Lanyard component (@ryu/ui) imports a binary .glb model as a URL asset.
	assetsInclude: ["**/*.glb"],
	optimizeDeps: {
		include: ["lucide-react"],
		// The desktop root also contains standalone e2e HTML stories. Let their
		// dedicated Vite configs own those graphs; the app dev server should only
		// pre-bundle the actual desktop entry point.
		entries: ["index.html"],
		esbuildOptions: {
			target: "chrome105",
		},
	},
	server: {
		port: 5173,
		strictPort: true,
		watch: {
			// A full page reload drops every open chat stream, so only app sources
			// may trigger one. Vite reloads on ANY changed .html under its root;
			// e2e proof pages, Playwright reports and Tauri's Rust tree are
			// written while agents work and are served by their own configs.
			ignored: [
				"**/e2e/**",
				"**/test-results/**",
				"**/playwright-report/**",
				"**/src-tauri/**",
				"**/coverage/**",
			],
		},
	},
	// SECURITY: never expose the bare `TAURI_` prefix here. Vite inlines every
	// matching env var into the frontend bundle, and the release build sets
	// TAURI_SIGNING_PRIVATE_KEY / _PASSWORD (release.yml) — so the updater's
	// minisign PRIVATE KEY gets shipped to users. This is CVE-2023-46115 /
	// GHSA-2rcp-jvr4-r259, and it was confirmed present in a local build here.
	// Only the non-sensitive platform vars are safe, so allow-list them.
	// Nothing in the desktop tree reads `import.meta.env.TAURI_*`, so the prefix
	// bought nothing and cost everything. `VITE_` only, same as apps/webapp.
	envPrefix: ["VITE_"],
	// Define the few non-VITE_ build values the renderer needs one key at a time
	// instead of widening `envPrefix`: the stats plugin's non-secret numeric
	// tuning knob (not arbitrary `CCSTATUSLINE_*` values) and the standalone app
	// identity.
	define: {
		// A few shared web blocks are imported by desktop pages and read
		// `process.env` for server-only defaults. Vite does not polyfill Node's
		// process object in a Tauri webview; make that server-only namespace an
		// inert browser value so a standalone app cannot fail before React mounts.
		"process.env": {},
		// The crash tier sets tracesSampleRate 0 and never logs SDK debug output:
		// compile both out of @sentry/react (as apps/web's SENTRY_BUNDLE_DEFINES).
		__SENTRY_DEBUG__: false,
		__SENTRY_TRACING__: false,
		"import.meta.env.CCSTATUSLINE_CONTEXT_SIZE_FALLBACK": JSON.stringify(
			process.env.CCSTATUSLINE_CONTEXT_SIZE_FALLBACK ?? ""
		),
		// The standalone app id has one source: RYU_STANDALONE_APP_ID, which
		// scripts/standalone.mjs sets and the Rust side bakes via option_env!.
		"import.meta.env.VITE_RYU_STANDALONE_APP_ID": JSON.stringify(
			process.env.RYU_STANDALONE_APP_ID ?? ""
		),
		"import.meta.env.VITE_RYU_STANDALONE_APP_NAME": JSON.stringify(
			standaloneAppName()
		),
	},
	build: {
		outDir: "dist",
		target: "chrome105",
		sourcemap: false,
	},
	resolve: {
		alias: [
			{ find: "@", replacement: path.resolve(import.meta.dirname, ".") },
			{ find: /^@hugeicons\/core-free-icons$/, replacement: modularIcons },
		],
	},
});
