// Every packaged `inline_js` tool body must be sealed from a reviewable source.
//
// `ToolConfig` has no `code_file`, so an inline tool's only loadable form is the
// manifest `code` string (the WIRE form). AGENTS.md bans hand-authored escaped
// blobs, so each body must come from a flat `.js` SOURCE file — either
// `tools/<slug>.js` byte-for-byte (toolsmith `sync`, agent-comms/goal `seal.mjs`),
// or a package `build.mjs` that generates the manifest and supports `--check`
// (ego-browser). Per-package tests check their own seal; this suite is the
// repo-wide sweep, so a new inline tool cannot ship unsealed or drifted.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeLineEndings } from "./manifest.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_ROOTS = [
	"apps-store",
	"plugins-store/plugins",
	"plugins-store/lsp",
	"plugins-store/external_plugins",
];

/** `{ dir, slug, code }` for every inline_js runnable in every package. */
function inlineTools() {
	const out = [];
	for (const root of PACKAGE_ROOTS) {
		const rootPath = join(REPO_ROOT, root);
		if (!existsSync(rootPath)) {
			continue;
		}
		for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
			const dir = join(rootPath, entry.name);
			const manifestPath = join(dir, "manifest.json");
			if (!(entry.isDirectory() && existsSync(manifestPath))) {
				continue;
			}
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			for (const runnable of manifest.runnables ?? []) {
				if (runnable.config?.backend === "inline_js") {
					out.push({
						dir,
						rel: `${root}/${entry.name}`,
						slug: runnable.config.slug,
						code: runnable.config.code,
					});
				}
			}
		}
	}
	return out;
}

const tools = inlineTools();
const builtPackages = new Set();

test("the sweep found the known inline tools (non-vacuous)", () => {
	assert.ok(
		tools.length > 0,
		"no inline_js runnable found — the manifest key must have been renamed"
	);
});

for (const { dir, rel, slug, code } of tools) {
	const source = join(dir, "tools", `${slug}.js`);
	if (existsSync(source)) {
		test(`${rel}: '${slug}' code equals tools/${slug}.js`, () => {
			assert.equal(typeof code, "string", "inline tool has no code string");
			assert.ok(
				normalizeLineEndings(code) ===
					normalizeLineEndings(readFileSync(source, "utf8")),
				`${rel}/manifest.json '${slug}' has drifted from tools/${slug}.js — reseal with the package's seal script or \`node tools/toolsmith/index.mjs sync\``
			);
		});
		continue;
	}
	const build = join(dir, "build.mjs");
	if (existsSync(build)) {
		if (builtPackages.has(dir)) {
			continue;
		}
		builtPackages.add(dir);
		test(`${rel}: build.mjs --check reports no drift`, () => {
			// Never run a build that lacks a check mode: it would rewrite the manifest.
			assert.ok(
				readFileSync(build, "utf8").includes('"--check"'),
				`${rel}/build.mjs has no --check mode`
			);
			const result = spawnSync(process.execPath, [build, "--check"], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			});
			assert.equal(
				result.status,
				0,
				`${rel}/build.mjs --check failed:\n${result.stderr}${result.stdout}`
			);
		});
		continue;
	}
	test(`${rel}: '${slug}' has a sealed source`, () => {
		assert.fail(
			`${rel}/manifest.json ships inline_js '${slug}' with no tools/${slug}.js source and no build.mjs — author the body as a flat fragment and seal it`
		);
	});
}
