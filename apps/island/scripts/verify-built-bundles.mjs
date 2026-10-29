// Post-build guard for the Island's Electron bundles, run by `bun run build`
// after `electron-vite build`. Usage: `node scripts/verify-built-bundles.mjs
// [--out <dir>] [--root <dir>]` (defaults: the Island package, and `<root>/out`);
// exit 1 lists every violation.
//
// Workspace packages publish TypeScript source, and Electron's Node cannot load
// a `.ts` file, so the main bundle must inline them. A package the main bundle
// still imports at runtime has to be one the packaged app contains (electron-
// builder packs `dependencies` and `optionalDependencies`, not devDependencies,
// and not whatever the workspace happens to hoist into `node_modules`) and has
// to resolve to JavaScript. The preload runs sandboxed, and a sandboxed
// preload's `require` serves only Electron's own short module list, so the
// preload must be self-contained. These failures only show at launch (a
// main-process crash, or a renderer without `window.island`); reading the
// emitted bundles makes them fail the build.

import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ISLAND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What a sandboxed preload's `require` can load (Electron's sandbox polyfill). */
const SANDBOXED_PRELOAD_MODULES = new Set([
	"electron",
	"electron/common",
	"electron/renderer",
]);

const BUILTINS = new Set(builtinModules);
const TYPESCRIPT_SOURCE = /\.(?:[cm]?ts|tsx)$/;
const BUNDLE_FILE = /\.(?:[cm]?js)$/;

// Rollup prints every runtime dependency as one of these string-literal forms.
const SPECIFIER_PATTERNS = [
	/\brequire\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
	/\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
	/^[ \t]*(?:import|export)\s[^;]*?\sfrom\s*(["'])([^"']+)\1/gm,
	/^[ \t]*import\s*(["'])([^"']+)\1/gm,
];

/** Every module specifier a bundle loads at runtime, in source order. */
function runtimeSpecifiers(source) {
	const found = new Set();
	for (const pattern of SPECIFIER_PATTERNS) {
		for (const match of source.matchAll(pattern)) {
			found.add(match[2]);
		}
	}
	return [...found];
}

function bundleFiles(directory) {
	if (!existsSync(directory)) {
		return [];
	}
	const files = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			files.push(...bundleFiles(path));
		} else if (BUNDLE_FILE.test(entry)) {
			files.push(path);
		}
	}
	return files;
}

function isRelative(specifier) {
	return (
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		specifier.startsWith("/")
	);
}

function isPlatformModule(specifier) {
	return (
		specifier === "electron" ||
		specifier.startsWith("electron/") ||
		specifier.startsWith("node:") ||
		BUILTINS.has(specifier)
	);
}

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function packageName(specifier) {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Check the main bundle: each package it imports at runtime must be a declared
 * dependency of the Island package and resolve from it to JavaScript. An
 * optional dependency may be absent (its loader is guarded), but never
 * TypeScript.
 */
function verifyMain(outDir, root, manifest) {
	const violations = [];
	const files = bundleFiles(join(outDir, "main"));
	if (files.length === 0) {
		violations.push(`main: no bundle under ${join(outDir, "main")}`);
	}
	const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
	const packaged = new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...optional,
	]);
	const requireFromIsland = createRequire(join(root, "package.json"));
	for (const file of files) {
		const label = relative(outDir, file);
		for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
			if (isRelative(specifier) || isPlatformModule(specifier)) {
				continue;
			}
			if (!packaged.has(packageName(specifier))) {
				violations.push(
					`${label}: "${specifier}" is not in the Island's dependencies or optionalDependencies, so the packaged app would not contain it; declare it or bundle it`
				);
				continue;
			}
			let resolved;
			try {
				resolved = requireFromIsland.resolve(specifier);
			} catch {
				if (!optional.has(packageName(specifier))) {
					violations.push(
						`${label}: "${specifier}" cannot be resolved from the Island package`
					);
				}
				continue;
			}
			if (TYPESCRIPT_SOURCE.test(resolved)) {
				violations.push(
					`${label}: "${specifier}" resolves to TypeScript source (${relative(root, resolved)}); bundle it`
				);
			}
		}
	}
	return { files, violations };
}

/** Check the sandboxed preload: it may require only Electron's sandbox modules. */
function verifyPreload(outDir) {
	const violations = [];
	const files = bundleFiles(join(outDir, "preload"));
	if (files.length === 0) {
		violations.push(`preload: no bundle under ${join(outDir, "preload")}`);
	}
	for (const file of files) {
		const label = relative(outDir, file);
		for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
			if (!SANDBOXED_PRELOAD_MODULES.has(specifier)) {
				violations.push(
					`${label}: "${specifier}" cannot be loaded by a sandboxed preload; bundle it`
				);
			}
		}
	}
	return { files, violations };
}

function pathArgument(args, flag, fallback) {
	const index = args.indexOf(flag);
	return index === -1 ? fallback : resolve(args[index + 1]);
}

const args = process.argv.slice(2);
// Resolved paths are real paths, so the root must be one too.
const root = realpathSync(pathArgument(args, "--root", ISLAND_ROOT));
const outDir = pathArgument(args, "--out", join(root, "out"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const main = verifyMain(outDir, root, manifest);
const preload = verifyPreload(outDir);
const violations = [...main.violations, ...preload.violations];
if (violations.length > 0) {
	process.stderr.write(
		`Island bundle check failed (${violations.length}):\n${violations
			.map((violation) => `  - ${violation}`)
			.join("\n")}\n`
	);
	process.exit(1);
}
process.stdout.write(
	`Island bundle check passed: ${main.files.length} main and ${preload.files.length} preload file(s).\n`
);
