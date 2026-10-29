import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// The Desktop program (and the extension, which type-checks Desktop source
// through its `@/*` path alias) resolves @ryu/ui and blocks source and peaks at
// roughly 6 GB of V8 heap under strict `tsc --noEmit`. Node's default heap
// (about 2 GB on many machines) aborts with "JavaScript heap out of memory",
// so the workspace scripts pin the heap themselves instead of relying on the
// caller's NODE_OPTIONS (CI, Turbo and local runs all go through the script).
const MIN_HEAP_MB = 8192;
const APPS_ROOT = join(import.meta.dir, "..", "..");

const packageScripts = z.object({ scripts: z.record(z.string(), z.string()) });

function scriptFor(workspace: string, script: string): string {
	const manifest = packageScripts.parse(
		JSON.parse(readFileSync(join(APPS_ROOT, workspace, "package.json"), "utf8"))
	);
	return manifest.scripts[script] ?? "";
}

function pinnedHeapMb(command: string): number {
	const match = command.match(/--max-old-space-size=(\d+)/);
	return match ? Number(match[1]) : 0;
}

describe("whole-program type-check heap", () => {
	it.each([
		["desktop", "check-types"],
		["extension", "compile"],
	])("%s %s pins a heap large enough for tsc", (workspace, script) => {
		const command = scriptFor(workspace, script);
		expect(command).toContain("tsc --noEmit");
		expect(pinnedHeapMb(command)).toBeGreaterThanOrEqual(MIN_HEAP_MB);
	});
});
