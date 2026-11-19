import { describe, expect, test } from "bun:test";
import {
	type IsolatedTestRun,
	resolveConcurrency,
	runIsolatedTestFiles,
} from "./isolated-test-pool.ts";

// Each child prints its start and end times on one line, sleeping in between,
// so the parent can reconstruct how many children overlapped.
function timedRun(file: string, exitCode = 0): IsolatedTestRun {
	const script = `const s = Date.now(); await Bun.sleep(150); console.log("${file}", s, Date.now()); process.exit(${exitCode});`;
	return { args: ["-e", script], file };
}

function maxOverlap(intervals: [number, number][]): number {
	const events = intervals.flatMap(([start, end]) => [
		[start, 1],
		[end, -1],
	]);
	// Ends sort before starts at the same instant: touching is not overlapping.
	events.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0));
	let live = 0;
	let peak = 0;
	for (const [, delta] of events) {
		live += delta ?? 0;
		peak = Math.max(peak, live);
	}
	return peak;
}

describe("runIsolatedTestFiles", () => {
	test("never runs more files at once than the concurrency limit", async () => {
		const chunks: string[] = [];
		const runs = ["a", "b", "c", "d", "e"].map((file) => timedRun(file));
		const failed = await runIsolatedTestFiles(runs, {
			concurrency: 2,
			write: (chunk) => chunks.push(chunk),
		});
		expect(failed).toEqual([]);
		const intervals = chunks.map((chunk) => {
			const [, start, end] = chunk.trim().split(" ");
			return [Number(start), Number(end)] as [number, number];
		});
		expect(intervals).toHaveLength(5);
		expect(maxOverlap(intervals)).toBeLessThanOrEqual(2);
	});

	test("reports failing files in input order and keeps each file's output whole", async () => {
		const chunks: string[] = [];
		const failed = await runIsolatedTestFiles(
			[
				timedRun("first", 1),
				timedRun("second"),
				timedRun("third", 3),
				{
					args: ["-e", 'console.log("one"); console.error("two")'],
					file: "fourth",
				},
			],
			{ concurrency: 4, write: (chunk) => chunks.push(chunk) }
		);
		expect(failed).toEqual(["first", "third"]);
		expect(chunks).toHaveLength(4);
		// stdout and stderr are separate pipes, so only their grouping is fixed.
		const fourth = chunks.find((chunk) => chunk.includes("one"));
		expect(fourth).toContain("two");
	});

	test("a command that cannot start counts as a failure", async () => {
		const chunks: string[] = [];
		const failed = await runIsolatedTestFiles([{ args: [], file: "missing" }], {
			command: "ryu-command-that-does-not-exist",
			write: (chunk) => chunks.push(chunk),
		});
		expect(failed).toEqual(["missing"]);
	});
});

describe("resolveConcurrency", () => {
	test("honors a positive override", () => {
		expect(resolveConcurrency("7", 2)).toBe(7);
	});

	test("defaults to the core count, capped at four, never below one", () => {
		expect(resolveConcurrency(undefined, 2)).toBe(2);
		expect(resolveConcurrency(undefined, 16)).toBe(4);
		expect(resolveConcurrency(undefined, 0)).toBe(1);
	});

	test("ignores a malformed or non-positive override", () => {
		expect(resolveConcurrency("abc", 8)).toBe(4);
		expect(resolveConcurrency("0", 8)).toBe(4);
		expect(resolveConcurrency("-3", 8)).toBe(4);
	});
});
