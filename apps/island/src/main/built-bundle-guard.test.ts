import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Runs the post-build bundle check (`scripts/verify-built-bundles.mjs`, the
// second half of `bun run build`) under Node against small emitted bundles.
// The two failing shapes are the ones the built Island shipped with: a main
// bundle that still imports a workspace package (TypeScript source Electron's
// Node cannot load) and a sandboxed preload that requires `zod`. The cases that
// depend on which packages the Island declares run against a synthetic package
// root (`--root`), so they do not hang on the real manifest's contents.
const SCRIPT = join(
	import.meta.dirname,
	"../../scripts/verify-built-bundles.mjs"
);

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

const UNDECLARED = (specifier: string): string =>
	`"${specifier}" is not in the Island's dependencies or optionalDependencies, so the packaged app would not contain it; declare it or bundle it`;

const CLEAN_MAIN = [
	'import { app, BrowserWindow } from "electron";',
	'import { join } from "node:path";',
	'import { z } from "zod";',
	'import "./chunks/startup.js";',
	"const optional = () => {",
	'\ttry { return require("electron-liquid-glass"); } catch { return null; }',
	"};",
].join("\n");
const CLEAN_PRELOAD = [
	'"use strict";',
	'const electron = require("electron");',
	'electron.contextBridge.exposeInMainWorld("island", {});',
].join("\n");

async function emit(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "island-bundle-guard-"));
	roots.push(root);
	for (const [path, source] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), source);
	}
	return root;
}

async function check(
	out: string,
	root?: string
): Promise<{ exit: number; stderr: string; stdout: string }> {
	const rootArguments = root ? ["--root", root] : [];
	const child = Bun.spawn(["node", SCRIPT, "--out", out, ...rootArguments], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exit, stderr, stdout };
}

test("a self-contained preload and a main bundle that imports only JavaScript pass", async () => {
	const out = await emit({
		"main/index.js": CLEAN_MAIN,
		"main/chunks/startup.js": 'import { ipcMain } from "electron";',
		"preload/index.cjs": CLEAN_PRELOAD,
	});
	expect(await check(out)).toEqual({
		exit: 0,
		stderr: "",
		stdout: "Island bundle check passed: 2 main and 1 preload file(s).\n",
	});
});

test("a main bundle that leaves a workspace package external fails the build", async () => {
	const out = await emit({
		"main/index.js": `${CLEAN_MAIN}\nimport { rawViewContributionSchema } from "@ryu/app-host/views";`,
		"preload/index.cjs": CLEAN_PRELOAD,
	});
	const result = await check(out);
	expect(result.exit).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe(
		[
			"Island bundle check failed (1):",
			`  - main/index.js: "@ryu/app-host/views" resolves to TypeScript source (${join("..", "..", "packages", "app-host", "src", "views.ts")}); bundle it`,
			"",
		].join("\n")
	);
});

test("a main bundle that imports a package the Island does not declare fails", async () => {
	const out = await emit({
		"main/index.js": `${CLEAN_MAIN}\nimport { missing } from "@ryu/not-an-island-dependency";`,
		"preload/index.cjs": CLEAN_PRELOAD,
	});
	const result = await check(out);
	expect(result.exit).toBe(1);
	expect(result.stderr).toBe(
		[
			"Island bundle check failed (1):",
			`  - main/index.js: ${UNDECLARED("@ryu/not-an-island-dependency")}`,
			"",
		].join("\n")
	);
});

test("an external import must be a declared dependency, however it resolves", async () => {
	// `dev-only` and `hoisted` resolve from the package root (a devDependency, and
	// a package another workspace member installed), but electron-builder packs
	// only `dependencies` and `optionalDependencies`, so neither is in the app.
	const root = await emit({
		"package.json": JSON.stringify({
			dependencies: {
				"declared-missing": "1.0.0",
				"declared-js": "1.0.0",
				"@ryu/declared-source": "workspace:*",
			},
			devDependencies: { "dev-only": "1.0.0" },
			optionalDependencies: { "optional-native": "1.0.0" },
		}),
		"node_modules/declared-js/package.json":
			'{"name":"declared-js","main":"index.js"}',
		"node_modules/declared-js/index.js": "module.exports = {};",
		"node_modules/declared-js/sub.js": "module.exports = {};",
		"node_modules/dev-only/package.json":
			'{"name":"dev-only","main":"index.js"}',
		"node_modules/dev-only/index.js": "module.exports = {};",
		"node_modules/hoisted/package.json": '{"name":"hoisted","main":"index.js"}',
		"node_modules/hoisted/index.js": "module.exports = {};",
		"node_modules/@ryu/declared-source/package.json":
			'{"name":"@ryu/declared-source","main":"src/index.ts"}',
		"node_modules/@ryu/declared-source/src/index.ts": "export {};",
	});
	const out = await emit({
		"main/index.js": [
			'import "declared-js";',
			'import "declared-js/sub";',
			'import "dev-only";',
			'import "hoisted";',
			'import "declared-missing";',
			'import "@ryu/declared-source";',
			'const optional = () => { try { return require("optional-native"); } catch { return null; } };',
		].join("\n"),
		"preload/index.cjs": CLEAN_PRELOAD,
	});
	const result = await check(out, root);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe(
		[
			"Island bundle check failed (4):",
			`  - main/index.js: ${UNDECLARED("dev-only")}`,
			`  - main/index.js: ${UNDECLARED("hoisted")}`,
			'  - main/index.js: "declared-missing" cannot be resolved from the Island package',
			`  - main/index.js: "@ryu/declared-source" resolves to TypeScript source (${join("node_modules", "@ryu", "declared-source", "src", "index.ts")}); bundle it`,
			"",
		].join("\n")
	);
	expect(result.exit).toBe(1);
});

test("a preload that requires anything but Electron's sandbox modules fails the build", async () => {
	const out = await emit({
		"main/index.js": CLEAN_MAIN,
		"preload/index.cjs": `${CLEAN_PRELOAD}\nconst zod = require("zod");\nconst shared = require("./ipc.cjs");\nconst events = require("node:events");`,
	});
	const result = await check(out);
	expect(result.exit).toBe(1);
	expect(result.stderr).toBe(
		[
			"Island bundle check failed (2):",
			'  - preload/index.cjs: "zod" cannot be loaded by a sandboxed preload; bundle it',
			'  - preload/index.cjs: "./ipc.cjs" cannot be loaded by a sandboxed preload; bundle it',
			"",
		].join("\n")
	);
});

test("a build that emitted no main or preload bundle fails", async () => {
	const out = await emit({ "renderer/index.html": "<!doctype html>" });
	const result = await check(out);
	expect(result.exit).toBe(1);
	expect(result.stderr).toBe(
		[
			"Island bundle check failed (2):",
			`  - main: no bundle under ${join(out, "main")}`,
			`  - preload: no bundle under ${join(out, "preload")}`,
			"",
		].join("\n")
	);
});
