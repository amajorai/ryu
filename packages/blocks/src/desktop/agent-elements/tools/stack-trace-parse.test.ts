import { describe, expect, it } from "bun:test";
import { looksLikeStackTrace, parseStackTrace } from "./stack-trace-parse.ts";

describe("parseStackTrace", () => {
	it("splits the error type from the message and parses named frames", () => {
		const trace = [
			"TypeError: x is not a function",
			"    at doThing (/app/src/index.ts:10:5)",
			"    at main (/app/src/index.ts:20:1)",
		].join("\n");
		const parsed = parseStackTrace(trace);
		expect(parsed.errorType).toBe("TypeError");
		expect(parsed.errorMessage).toBe("x is not a function");
		expect(parsed.frames).toHaveLength(2);
		expect(parsed.frames[0]).toMatchObject({
			fn: "doThing",
			file: "/app/src/index.ts",
			line: 10,
			col: 5,
			internal: false,
		});
	});

	it("handles anonymous frames without a function name", () => {
		const trace = "Error: boom\n    at /app/x.js:3:7";
		const [frame] = parseStackTrace(trace).frames;
		expect(frame.fn).toBe("");
		expect(frame.file).toBe("/app/x.js");
		expect(frame.line).toBe(3);
		expect(frame.col).toBe(7);
	});

	it("flags node internals and node_modules as internal frames", () => {
		const trace = [
			"Error: e",
			"    at foo (/proj/node_modules/dep/index.js:1:1)",
			"    at process (node:internal/process/task_queues:95:5)",
			"    at app (/proj/src/a.ts:2:2)",
		].join("\n");
		const { frames } = parseStackTrace(trace);
		expect(frames.map((f) => f.internal)).toEqual([true, true, false]);
	});

	it("keeps the whole header as the message when there is no colon", () => {
		const parsed = parseStackTrace("Something failed\n    at a (b.js:1:1)");
		expect(parsed.errorType).toBe("");
		expect(parsed.errorMessage).toBe("Something failed");
	});

	it("normalizes CRLF line endings", () => {
		const parsed = parseStackTrace("Error: e\r\n    at a (b.js:1:2)\r\n");
		expect(parsed.frames).toHaveLength(1);
		expect(parsed.errorMessage).toBe("e");
	});

	it("leaves line/col undefined for a location without them", () => {
		const [frame] = parseStackTrace("Error: e\n    at nowhere").frames;
		expect(frame.file).toBe("nowhere");
		expect(frame.line).toBeUndefined();
		expect(frame.col).toBeUndefined();
	});
});

describe("looksLikeStackTrace", () => {
	it("is true only when at least one `at …` frame line exists", () => {
		expect(looksLikeStackTrace("Error: e\n    at foo (a.js:1:1)")).toBe(true);
	});

	it("rejects a plain single-line error string", () => {
		expect(looksLikeStackTrace("Error: nope")).toBe(false);
	});

	it("rejects non-string input", () => {
		expect(looksLikeStackTrace(null)).toBe(false);
		expect(looksLikeStackTrace(42)).toBe(false);
		expect(looksLikeStackTrace({ at: "x" })).toBe(false);
	});
});
