// Both Island windows run sandboxed renderers. A sandboxed preload's `require`
// resolves only Electron's sandbox modules: never a package from node_modules and
// never a relative chunk file. Rollup turns a local module that BOTH preload
// entries import at runtime into a shared `chunks/*.cjs`, and
// `externalizeDepsPlugin` leaves every dependency as a `require`; either one makes
// a preload throw before `contextBridge.exposeInMainWorld` runs. These tests walk
// each entry's runtime import graph (type-only imports are erased, as in the
// build) so both mistakes fail here, before a build; `electron.vite.config.ts`
// re-checks the emitted bundle.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { IPC } from "../shared/ipc.ts";
import { SURFACE_CHANNELS } from "../shared/screen-surface.ts";
import { SCREEN_WINDOW_CHANNELS } from "./surface-channels.ts";

/** What a sandboxed preload's `require` can load (Electron's sandbox polyfill). */
const SANDBOXED_PRELOAD_MODULES = new Set([
	"electron",
	"events",
	"timers",
	"url",
]);
const sourceRoot = resolve(import.meta.dirname, "..");
const transpilers = {
	ts: new Bun.Transpiler({ loader: "ts" }),
	tsx: new Bun.Transpiler({ loader: "tsx" }),
};

interface RuntimeGraph {
	dynamicImports: string[];
	externals: Set<string>;
	locals: Set<string>;
}

function resolveLocal(from: string, specifier: string): string {
	const base = resolve(dirname(from), specifier);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		join(base, "index.ts"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			return candidate;
		}
	}
	throw new Error(`cannot resolve ${specifier} from ${from}`);
}

function runtimeGraph(entry: string): RuntimeGraph {
	const graph: RuntimeGraph = {
		dynamicImports: [],
		externals: new Set(),
		locals: new Set(),
	};
	const queue = [resolve(import.meta.dirname, entry)];
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || graph.locals.has(file)) {
			continue;
		}
		graph.locals.add(file);
		const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
		for (const { kind, path } of transpiler.scanImports(
			readFileSync(file, "utf8")
		)) {
			if (kind === "dynamic-import") {
				graph.dynamicImports.push(`${relative(sourceRoot, file)} -> ${path}`);
			}
			if (path.startsWith(".")) {
				queue.push(resolveLocal(file, path));
			} else {
				graph.externals.add(path.replace(/^node:/, ""));
			}
		}
	}
	return graph;
}

const islandPreload = runtimeGraph("index.ts");
const screenPreload = runtimeGraph("surface.ts");

describe("sandboxed preloads", () => {
	test("require only modules a sandboxed preload can load", () => {
		for (const graph of [islandPreload, screenPreload]) {
			expect(
				[...graph.externals].filter((id) => !SANDBOXED_PRELOAD_MODULES.has(id))
			).toEqual([]);
			expect(graph.dynamicImports).toEqual([]);
		}
	});

	test("share no runtime module, so Rollup emits no shared chunk", () => {
		const shared = [...islandPreload.locals]
			.filter((file) => screenPreload.locals.has(file))
			.map((file) => relative(sourceRoot, file));
		expect(shared).toEqual([]);
	});

	test("the screen window's preload bundles only its own channel table", () => {
		expect(
			[...screenPreload.locals].map((file) => relative(sourceRoot, file)).sort()
		).toEqual(["preload/surface-channels.ts", "preload/surface.ts"]);
	});
});

test("the screen window's channels match the shared IPC contract", () => {
	expect(SCREEN_WINDOW_CHANNELS).toEqual({
		dismiss: SURFACE_CHANNELS.dismiss,
		languagePacksGet: IPC.languagePacks.get,
		ready: SURFACE_CHANNELS.ready,
		setMouseCapture: SURFACE_CHANNELS.setMouseCapture,
		state: SURFACE_CHANNELS.state,
		submit: SURFACE_CHANNELS.submit,
		themeChanged: IPC.theme.changed,
		themeGet: IPC.theme.get,
	});
});
