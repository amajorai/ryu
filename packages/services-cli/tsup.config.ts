import { defineConfig, type Options } from "tsup";

/**
 * Published entry points, keyed by their `dist/` path. `src/index.ts` is the
 * side-effect-free library entry and `src/bin.ts` the `ryu-services` bin;
 * `exports-lockstep.test.ts` keeps this, package.json `exports`/`bin` and the
 * files on disk in agreement.
 */
export const ENTRIES = {
	index: "src/index.ts",
	bin: "src/bin.ts",
} as const;

const SHARED = {
	format: ["esm"],
	platform: "node",
	target: "node20",
	external: ["@ryuhq/services", "@modelcontextprotocol/server", "zod"],
} satisfies Options;

/**
 * Two builds so only the bin starts with a shebang: the library entry is an
 * importable module, not an executable. The bin build runs second and must
 * not clean `dist/`.
 */
export default defineConfig([
	{ ...SHARED, entry: { index: ENTRIES.index }, dts: true },
	{
		...SHARED,
		entry: { bin: ENTRIES.bin },
		dts: true,
		banner: { js: "#!/usr/bin/env node" },
	},
]);
