import { sep } from "node:path";
import { defineConfig } from "tsup";

/**
 * Published entry points, keyed by their `dist/` path. `exports-lockstep.test.ts`
 * keeps this, package.json `exports` and the files on disk in agreement.
 */
export const ENTRIES = {
	index: "src/index.ts",
	"webhooks/index": "src/webhooks/index.ts",
	errors: "src/errors.ts",
	"tools/index": "src/tools/index.ts",
} as const;

const TOOLS_DIR = `${sep}src${sep}tools${sep}`;

/** The minimal esbuild plugin shape used here (tsup does not re-export esbuild's types). */
interface ResolvePlugin {
	name: string;
	setup(build: {
		onResolve(
			options: { filter: RegExp },
			callback: (args: {
				importer: string;
			}) => { external: true; path: string } | undefined
		): void;
	}): void;
}

/**
 * Loads `src/tools/core.ts` (the tools' only runtime seam to the rest of the
 * package) from the package's own root entry, `@ryuhq/services`, instead of
 * bundling it. tsup does not code-split CJS, so without this
 * dist/tools/index.cjs would carry its own copy of result.ts and errors.ts:
 * a second per-call meta map the root entry's `Ryu` never fills, and RyuError
 * classes that fail `instanceof` against the root entry's.
 */
export const toolsCoreExternal: ResolvePlugin = {
	name: "ryu-services-tools-core-external",
	setup(build) {
		build.onResolve({ filter: /^\.{1,2}\/(?:tools\/)?core\.ts$/ }, (args) =>
			args.importer.includes(TOOLS_DIR)
				? { path: "@ryuhq/services", external: true }
				: undefined
		);
	},
};

export default defineConfig({
	entry: ENTRIES,
	format: ["esm", "cjs"],
	dts: true,
	platform: "neutral",
	target: "es2022",
	external: ["@ryuhq/client", "zod", "@react-email/render"],
	esbuildPlugins: [toolsCoreExternal],
});
