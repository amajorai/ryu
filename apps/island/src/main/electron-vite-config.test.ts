import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The shape `electron.vite.config.ts` must keep for the BUILT Island to launch:
// the main bundle inlines every workspace package (they publish TypeScript that
// Electron's Node cannot load) and the sandboxed preload inlines every
// dependency (its `require` serves only Electron's own modules). The post-build
// guard (`scripts/verify-built-bundles.mjs`) catches a regression only in
// `release-island.yml` and the local `dist*` scripts; pull-request CI does not
// build the Island, so this test is what a config regression meets there.
const ISLAND_ROOT = join(import.meta.dirname, "../..");

interface RollupOptions {
	external?: Array<string | RegExp>;
	input?: Record<string, string>;
	output?: { entryFileNames?: string; format?: string };
}

interface ViteBuild {
	rollupOptions?: RollupOptions;
}

interface VitePlugin {
	config?: (config: { build?: ViteBuild }, env: unknown) => void;
	name?: string;
}

interface ProcessConfig {
	build?: ViteBuild;
	plugins?: VitePlugin[];
}

interface IslandConfig {
	main: ProcessConfig;
	preload: ProcessConfig;
}

const EXTERNALIZE_DEPS = "vite:externalize-deps";
const SANDBOXED_PRELOAD_GUARD = "island:sandboxed-preload-guard";

const manifest = JSON.parse(
	readFileSync(join(ISLAND_ROOT, "package.json"), "utf8")
) as { dependencies: Record<string, string> };
const workspaceDependencies = Object.entries(manifest.dependencies)
	.filter(([, version]) => version.startsWith("workspace:"))
	.map(([name]) => name)
	.sort();
const publishedDependencies = Object.keys(manifest.dependencies)
	.filter((name) => !workspaceDependencies.includes(name))
	.sort();

/**
 * electron-vite's `externalizeDepsPlugin` reads the `package.json` of the
 * process's working directory when the config module is evaluated, and the
 * build runs from the Island package, so load the config from there.
 */
async function loadConfig(): Promise<IslandConfig> {
	const cwd = process.cwd();
	process.chdir(ISLAND_ROOT);
	try {
		const loaded = await import("../../electron.vite.config.ts");
		return loaded.default as unknown as IslandConfig;
	} finally {
		process.chdir(cwd);
	}
}

const config = await loadConfig();

/** What the main bundle leaves external: the plugin's `rollupOptions.external`. */
function mainExternals(): Array<string | RegExp> {
	const plugin = config.main.plugins?.find(
		(candidate) => candidate.name === EXTERNALIZE_DEPS
	);
	const resolved: { build?: ViteBuild } = {};
	plugin?.config?.(resolved, { command: "build", mode: "production" });
	return resolved.build?.rollupOptions?.external ?? [];
}

function isExternal(
	externals: Array<string | RegExp>,
	specifier: string
): boolean {
	return externals.some((entry) =>
		typeof entry === "string" ? entry === specifier : entry.test(specifier)
	);
}

test("the Island declares workspace packages for the check to cover", () => {
	// A config that excluded nothing would also "equal" an empty list below.
	expect(workspaceDependencies).toEqual(
		expect.arrayContaining(["@ryu/app-host", "@ryu/i18n", "@ryuhq/core-client"])
	);
	expect(publishedDependencies).toEqual(
		expect.arrayContaining(["electron-updater", "zod"])
	);
});

test("the main bundle leaves external exactly the published dependencies, and inlines every workspace one", () => {
	const externals = mainExternals();
	const externalNames = externals
		.filter((entry): entry is string => typeof entry === "string")
		.sort();
	expect(externalNames).toEqual(publishedDependencies);

	for (const name of workspaceDependencies) {
		expect(isExternal(externals, name)).toBe(false);
		expect(isExternal(externals, `${name}/views`)).toBe(false);
	}
	for (const name of publishedDependencies) {
		expect(isExternal(externals, name)).toBe(true);
		expect(isExternal(externals, `${name}/subpath`)).toBe(true);
	}
});

test("the preload bundles its dependencies and emits one CommonJS file per entry", () => {
	// No externalize plugin: a sandboxed preload cannot `require` a package. The
	// only plugin is the guard that fails the build on a shared chunk or a
	// leftover `require`.
	const pluginNames = (config.preload.plugins ?? []).map(
		(plugin) => plugin.name
	);
	expect(pluginNames).not.toContain(EXTERNALIZE_DEPS);
	expect(pluginNames).toEqual([SANDBOXED_PRELOAD_GUARD]);
	const rollupOptions = config.preload.build?.rollupOptions;
	expect(rollupOptions?.output?.format).toBe("cjs");
	// One self-contained file per sandboxed window: the Island window's preload
	// (`index`) and the on-screen generative UI window's (`surface`).
	expect(rollupOptions?.output?.entryFileNames).toBe("[name].cjs");
	expect(Object.keys(rollupOptions?.input ?? {}).sort()).toEqual([
		"index",
		"surface",
	]);
	expect(rollupOptions?.external).toBeUndefined();
});
