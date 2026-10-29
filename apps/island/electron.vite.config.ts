import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import packageJson from "./package.json" with { type: "json" };

// Workspace packages publish TypeScript source, which Electron's Node cannot
// load, so the main bundle inlines every `workspace:` dependency and leaves only
// published npm packages external. `scripts/verify-built-bundles.mjs` checks the
// emitted bundles after every build.
const workspacePackages = Object.entries(packageJson.dependencies)
	.filter(([, version]) => version.startsWith("workspace:"))
	.map(([name]) => name);

/** What a sandboxed preload's `require` can load (Electron's sandbox polyfill). */
const SANDBOXED_PRELOAD_MODULES = new Set([
	"electron",
	"events",
	"timers",
	"url",
]);

/**
 * Both Island windows run sandboxed renderers, so each preload must be ONE
 * self-contained `.cjs`: a sandboxed preload cannot `require` a relative chunk
 * or a package from node_modules. Rollup emits a shared `chunks/*.cjs` when the
 * two entries import the same local module at runtime, and leaves a `require`
 * for anything it is told not to bundle (the preload deliberately has no
 * `externalizeDepsPlugin`, so only `electron` and Node built-ins stay external),
 * so fail the build on either instead of shipping a preload that throws before
 * `contextBridge` runs.
 * `src/preload/sandbox.test.ts` checks the same rule from source.
 */
function sandboxedPreloadGuard(): Plugin {
	return {
		name: "island:sandboxed-preload-guard",
		generateBundle(_options, bundle) {
			for (const output of Object.values(bundle)) {
				if (output.type !== "chunk") {
					continue;
				}
				if (!output.isEntry) {
					this.error(
						`preload chunk ${output.fileName} is shared between entries; a sandboxed preload cannot require it`
					);
				}
				const unsafe = [...output.imports, ...output.dynamicImports].filter(
					(id) => !SANDBOXED_PRELOAD_MODULES.has(id)
				);
				if (unsafe.length > 0) {
					this.error(
						`preload ${output.fileName} requires ${unsafe.join(", ")}, which a sandboxed preload cannot load`
					);
				}
			}
		},
	};
}

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
		build: {
			rollupOptions: {
				input: resolve(import.meta.dirname, "src/main/index.ts"),
			},
		},
	},
	// The preload runs sandboxed, where `require` serves only Electron's own
	// modules, so it bundles every dependency (electron-vite still leaves
	// `electron` and Node built-ins external).
	preload: {
		plugins: [sandboxedPreloadGuard()],
		build: {
			rollupOptions: {
				// Two sandboxed preloads that must not share a runtime module (see
				// `sandboxedPreloadGuard`): the Island window's and the on-screen
				// generative UI window's (`main/screen-surface.ts`).
				input: {
					index: resolve(import.meta.dirname, "src/preload/index.ts"),
					surface: resolve(import.meta.dirname, "src/preload/surface.ts"),
				},
				output: {
					format: "cjs",
					entryFileNames: "[name].cjs",
				},
			},
		},
	},
	renderer: {
		root: resolve(import.meta.dirname, "src/renderer"),
		// Pin to 5174 so it never collides with the desktop app's vite (5173,
		// strictPort) when both run under the monorepo `bun dev`.
		server: {
			port: 5174,
			strictPort: true,
		},
		plugins: [react()],
		css: {
			postcss: {
				plugins: [tailwindcss()],
			},
		},
		resolve: {
			alias: {
				"@": resolve(import.meta.dirname, "src/renderer"),
			},
		},
		build: {
			rollupOptions: {
				input: {
					index: resolve(import.meta.dirname, "src/renderer/index.html"),
					// The on-screen generative UI window (main/screen-surface.ts).
					surface: resolve(import.meta.dirname, "src/renderer/surface.html"),
				},
			},
		},
	},
});
