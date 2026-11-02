import { describe, expect, test } from "bun:test";
import { parseIsolatedRunArgs, selectTestFiles } from "./test-isolated-args";

const files = [
	"e2e/foo.host.test.ts",
	"lib/time.test.ts",
	"src/store/useNodeStore.test.ts",
];

describe("test-isolated argument handling", () => {
	test("runs every file when no filter is given", () => {
		const { filters, childFlags } = parseIsolatedRunArgs([]);
		expect(filters).toEqual([]);
		expect(childFlags).toEqual([]);
		expect(selectTestFiles(files, filters)).toEqual(files);
	});

	test("positional arguments select the files whose path contains them", () => {
		const { filters } = parseIsolatedRunArgs([
			"./src/store/useNodeStore.test.ts",
			"time",
		]);
		expect(selectTestFiles(files, filters)).toEqual([
			"lib/time.test.ts",
			"src/store/useNodeStore.test.ts",
		]);
	});

	test("a filter that matches nothing selects nothing", () => {
		expect(selectTestFiles(files, ["missing.test.ts"])).toEqual([]);
	});

	test("flags and their values are forwarded, not treated as filters", () => {
		expect(
			parseIsolatedRunArgs(["-t", "auto-selects", "--bail", "--", "lib/"])
		).toEqual({
			childFlags: ["-t", "auto-selects", "--bail"],
			filters: ["lib/"],
		});
	});
});
