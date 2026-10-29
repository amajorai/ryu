// The built `@ryuhq/services/tools` entry shares one module instance with the
// root entry, in both the ESM and the CJS build. The other tests run the TS
// sources, where there is only one copy of everything; this one builds the
// package with the real tsup entries and the `toolsCoreExternal` plugin into a
// temporary node_modules/@ryuhq/services and runs the same tool call through
// `require()` and `import` in Node.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsup";
import { ENTRIES, toolsCoreExternal } from "../../tsup.config.ts";

const PACKAGE_DIR = resolve(import.meta.dir, "../..");
const FIXTURE = join(PACKAGE_DIR, "test/fixtures/notify/events-page-1.json");

let root = "";
let packageDir = "";

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ryu-services-dist-"));
	packageDir = join(root, "node_modules/@ryuhq/services");
	mkdirSync(packageDir, { recursive: true });
	copyFileSync(
		join(PACKAGE_DIR, "package.json"),
		join(packageDir, "package.json")
	);
	symlinkSync(
		realpathSync(join(PACKAGE_DIR, "node_modules/zod")),
		join(root, "node_modules/zod")
	);
	await build({
		config: false,
		silent: true,
		entry: Object.fromEntries(
			Object.entries(ENTRIES).map(([name, source]) => [
				name,
				join(PACKAGE_DIR, source),
			])
		),
		format: ["esm", "cjs"],
		dts: false,
		platform: "neutral",
		target: "es2022",
		outDir: join(packageDir, "dist"),
		// @ryuhq/client's dist is not built in the workspace; bundle its source.
		noExternal: ["@ryuhq/client"],
		external: ["zod", "@react-email/render"],
		esbuildPlugins: [toolsCoreExternal],
	});
}, 60_000);

afterAll(() => {
	if (root !== "") {
		rmSync(root, { recursive: true, force: true });
	}
});

/** A probe that runs one tool call through the built entries and prints what it saw. */
function probe(kind: "cjs" | "mjs"): string {
	const load =
		kind === "cjs"
			? `const services = require("@ryuhq/services");
const tools = require("@ryuhq/services/tools");`
			: `const services = await import("@ryuhq/services");
const tools = await import("@ryuhq/services/tools");`;
	const body = `${load}
const fixture = ${readFileSync(FIXTURE, "utf8")};
const ryu = new services.Ryu({
	env: { RYU_NOTIFY_URL: "https://notify.example.com", RYU_NOTIFY_API_KEY: "k" },
	maxRetries: 0,
	fetch: async () => new Response(JSON.stringify(fixture.body), { status: fixture.status, headers: fixture.headers }),
});
const output = await tools.toAiSdkTools(ryu).notify_list_events.execute({ limit: 1 });
const invalid = await tools.runRyuTool(ryu, tools.getRyuTool("notify_get_event"), {});
console.log(JSON.stringify({
	meta: output.meta,
	invalidIsRyuError: invalid.error instanceof services.RyuError,
	invalidIsInvalidRequest: invalid.error instanceof services.RyuInvalidRequestError,
}));`;
	const file = join(root, `probe.${kind}`);
	writeFileSync(file, kind === "cjs" ? `(async () => {\n${body}\n})();` : body);
	return file;
}

/** Runs `file` in Node; the parsed probe output, or the stderr when it failed. */
function runNode(file: string): unknown {
	const result = spawnSync("node", [file], { cwd: root, encoding: "utf8" });
	return result.stderr === ""
		? (JSON.parse(result.stdout) as unknown)
		: { stderr: result.stderr };
}

describe("the built tools entry", () => {
	test("loads the root entry instead of bundling a copy of it", () => {
		for (const file of ["tools/index.cjs", "tools/index.js"]) {
			const source = readFileSync(join(packageDir, "dist", file), "utf8");
			expect({ file, external: source.includes('"@ryuhq/services"') }).toEqual({
				file,
				external: true,
			});
			expect({ file, copy: source.includes("CALL_META") }).toEqual({
				file,
				copy: false,
			});
		}
	});

	for (const kind of ["cjs", "mjs"] as const) {
		test(`${kind}: a tool result carries the facade call's meta, and errors are the root's classes`, () => {
			expect(runNode(probe(kind))).toEqual({
				meta: { requestId: "req_4cbae62e029546ccb69dea25d83c62ba" },
				invalidIsRyuError: true,
				invalidIsInvalidRequest: true,
			});
		});
	}
});
