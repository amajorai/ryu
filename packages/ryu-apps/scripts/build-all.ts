#!/usr/bin/env bun
// Builds every widget app as its own single-input Vite build so each emitted
// `dist/<slug>.html` is fully self-contained (no external `./chunk.js`). A
// multi-entry build would hoist a shared react chunk that vite-plugin-singlefile
// leaves external, breaking the widget under the null-origin CSP iframe (D3).

import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const appsDir = resolve(pkgRoot, "src/apps");
const distDir = resolve(pkgRoot, "dist");

function widgetSlugs(): string[] {
	return readdirSync(appsDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				existsSync(resolve(appsDir, entry.name, "index.html")),
		)
		.map((entry) => entry.name)
		.sort();
}

const slugs = widgetSlugs();
if (slugs.length === 0) {
	throw new Error("No widget apps with an index.html entry found.");
}

// Clean once up front; per-app builds use emptyOutDir:false so they accumulate.
rmSync(distDir, { recursive: true, force: true });

for (const slug of slugs) {
	// biome-ignore lint/suspicious/noConsole: build progress
	console.log(`\n[build-all] building ${slug} ...`);
	const proc = Bun.spawnSync(["bunx", "vite", "build"], {
		cwd: pkgRoot,
		env: { ...process.env, RYU_APP_SLUG: slug },
		stdout: "inherit",
		stderr: "inherit",
	});
	if (proc.exitCode !== 0) {
		throw new Error(`vite build failed for '${slug}' (exit ${proc.exitCode})`);
	}
}

// biome-ignore lint/suspicious/noConsole: build summary
console.log(
	`\n[build-all] built ${slugs.length} widget bundles: ${slugs.join(", ")}`,
);
