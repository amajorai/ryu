import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Per-app Vite build (one app per invocation, selected by `RYU_APP_SLUG`). Each
// build has a SINGLE input so `vite-plugin-singlefile` (recommended config =
// inlineDynamicImports + one chunk) inlines ALL JS + CSS into the HTML, making
// the emitted bundle self-contained with ZERO external fetches. This is required
// under the widget CSP `default-src 'none'` (D3): a multi-entry build hoists a
// shared `tokens-*.js` react chunk that singlefile leaves external, which cannot
// load in the null-origin srcdoc iframe. `scripts/build-all.ts` loops this per
// app; `scripts/embed.ts` then embeds each `dist/<slug>.html` into Core.

const here = dirname(fileURLToPath(import.meta.url));
const appsDir = resolve(here, "src/apps");

/** App slugs that have an `index.html` entry. */
function widgetSlugs(): string[] {
	return readdirSync(appsDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				existsSync(resolve(appsDir, entry.name, "index.html")),
		)
		.map((entry) => entry.name);
}

const HTML_KEY_RE = /apps[/\\]([^/\\]+)[/\\]index\.html$/;

/** Flatten `dist/src/apps/<slug>/index.html` down to `dist/<slug>.html`. */
function flattenWidgetHtml(): Plugin {
	return {
		name: "ryu-flatten-widget-html",
		enforce: "post",
		generateBundle(_options, bundle) {
			for (const key of Object.keys(bundle)) {
				if (!key.endsWith(".html")) {
					continue;
				}
				const slug = HTML_KEY_RE.exec(key)?.[1];
				if (!slug) {
					continue;
				}
				const asset = bundle[key];
				if (!asset) {
					continue;
				}
				delete bundle[key];
				(asset as { fileName: string }).fileName = `${slug}.html`;
				bundle[`${slug}.html`] = asset;
			}
		},
	};
}

const slug = process.env.RYU_APP_SLUG;
if (!slug) {
	throw new Error(
		"RYU_APP_SLUG is required; run `bun run build` (scripts/build-all.ts loops every app).",
	);
}
const available = widgetSlugs();
if (!available.includes(slug)) {
	throw new Error(
		`Unknown app slug '${slug}'. Available: ${available.join(", ")}`,
	);
}
const entry = resolve(appsDir, slug, "index.html");

export default defineConfig({
	root: here,
	// Each widget document is a null-origin srcdoc; assets must resolve relatively.
	base: "./",
	plugins: [
		react(),
		// Single input => the recommended config fully inlines everything.
		viteSingleFile(),
		flattenWidgetHtml(),
	],
	build: {
		outDir: "dist",
		// Never wipe sibling apps built in earlier loop iterations.
		emptyOutDir: false,
		target: "esnext",
		cssCodeSplit: false,
		assetsInlineLimit: Number.POSITIVE_INFINITY,
		modulePreload: { polyfill: false },
		rollupOptions: {
			input: { [slug]: entry },
			output: { inlineDynamicImports: true },
		},
	},
});
