import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./test-isolated.ts", import.meta.url));
function withFixtures<T>(
	fixtures: Record<string, string>,
	run: (cwd: string) => T
): T {
	const cwd = mkdtempSync(join(tmpdir(), "ryu-blocks-runner-"));
	try {
		for (const [path, source] of Object.entries(fixtures)) {
			const destination = join(cwd, path);
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, source);
		}
		return run(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}
function run(cwd: string, args = [runner]) {
	return spawnSync(process.execPath, args, {
		cwd,
		env: { ...process.env, NODE_ENV: "development" },
		encoding: "utf8",
		timeout: 20_000,
	});
}
test("the default runner prevents a real module mock from replacing another file's genuine engine", () => {
	withFixtures(
		{
			"src/engine.ts": 'export function engine() { return "genuine"; }',
			"src/a-fallback.test.ts":
				'import { expect, mock, test } from "bun:test"; mock.module("./engine.ts", () => ({ engine: () => "fallback" })); const { engine } = await import("./engine.ts"); test("fallback fixture", () => { expect(engine()).toBe("fallback"); });',
			"src/b-primary.test.ts":
				'import { expect, test } from "bun:test"; import { engine } from "./engine.ts"; test("genuine primary", () => { expect(engine()).toBe("genuine"); });',
		},
		(cwd) => {
			const shared = run(cwd, [
				"test",
				"./src/a-fallback.test.ts",
				"./src/b-primary.test.ts",
			]);
			expect(shared.status).toBe(1);
			const isolated = run(cwd);
			expect(isolated.status).toBe(0);
			expect(isolated.stdout).toContain("2/2 test files green");
		}
	);
});
test("discovers TS, TSX and runner regression suites, handles spaced paths and propagates failure", () => {
	withFixtures(
		{
			"src/passing.test.ts":
				'import { expect, test } from "bun:test"; test("test environment", () => { expect(process.env.NODE_ENV).toBe("test"); });',
			"src/spaced view.test.tsx":
				'import { test } from "bun:test"; test("failure fixture", () => { throw new Error("fixture failure"); });',
			"scripts/runner.test.ts":
				'import { test } from "bun:test"; test("runner regression", () => {});',
		},
		(cwd) => {
			const result = run(cwd);
			expect(result.status).toBe(1);
			expect(result.stdout).toContain("2/3 test files green");
			expect(result.stderr).toContain("FAIL src/spaced view.test.tsx");
		}
	);
});
test("an empty test inventory fails instead of silently passing", () => {
	withFixtures({}, (cwd) => {
		const result = run(cwd);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no test files found");
	});
});
