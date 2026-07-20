// Verifies the bug-risk logic behind the AI-SDK-Elements-style chat components:
// stack-trace parsing and the web-tool citation producer. These are pure (no
// @ryu/ui imports), so they run under `bun test`; component rendering is
// verified in the running app (vite).

import { describe, expect, test } from "bun:test";
import {
	looksLikeStackTrace,
	parseStackTrace,
} from "./tools/stack-trace-parse.ts";
import { extractCitations } from "./utils/citations.ts";

const SAMPLE_TRACE = [
	"TypeError: Cannot read properties of undefined (reading 'x')",
	"    at Object.<anonymous> (/app/src/index.js:10:15)",
	"    at Module._compile (node:internal/modules/cjs/loader:1234:14)",
	"    at /app/node_modules/foo/bar.js:5:3",
].join("\n");

describe("stack-trace parsing", () => {
	test("looksLikeStackTrace gates on real frames", () => {
		expect(looksLikeStackTrace(SAMPLE_TRACE)).toBe(true);
		expect(looksLikeStackTrace("Error: nope")).toBe(false);
		expect(looksLikeStackTrace(42)).toBe(false);
		expect(looksLikeStackTrace(undefined)).toBe(false);
	});

	test("parseStackTrace splits header and frames", () => {
		const parsed = parseStackTrace(SAMPLE_TRACE);
		expect(parsed.errorType).toBe("TypeError");
		expect(parsed.errorMessage).toContain("Cannot read properties");
		expect(parsed.frames).toHaveLength(3);
		expect(parsed.frames[0]?.file).toBe("/app/src/index.js");
		expect(parsed.frames[0]?.line).toBe(10);
		expect(parsed.frames[0]?.col).toBe(15);
		expect(parsed.frames[0]?.fn).toBe("Object.<anonymous>");
		// node: and node_modules frames are internal; the app frame is not.
		expect(parsed.frames.filter((f) => f.internal)).toHaveLength(2);
		expect(parsed.frames[0]?.internal).toBe(false);
	});

	test("parseStackTrace tolerates a header with no error type", () => {
		const parsed = parseStackTrace("boom\n    at run (/a.js:1:1)");
		expect(parsed.errorType).toBe("");
		expect(parsed.errorMessage).toBe("boom");
		expect(parsed.frames).toHaveLength(1);
	});
});

describe("citation extraction", () => {
	test("WebFetch part yields a citation with title + number", () => {
		const citations = extractCitations([
			{
				type: "tool-WebFetch",
				input: { url: "https://example.com/docs/page" },
				output: { title: "Docs Page", summary: "A summary." },
			},
		]);
		expect(citations).toHaveLength(1);
		expect(citations[0]?.url).toBe("https://example.com/docs/page");
		expect(citations[0]?.title).toBe("Docs Page");
		expect(citations[0]?.number).toBe(1);
	});

	test("WebFetch without a title falls back to the hostname", () => {
		const citations = extractCitations([
			{ type: "tool-WebFetch", input: { url: "https://www.example.com/x" } },
		]);
		expect(citations[0]?.title).toBe("example.com");
	});

	test("WebSearch results with urls become numbered, deduped citations", () => {
		const citations = extractCitations([
			{
				type: "dynamic-tool",
				toolName: "WebSearch",
				output: {
					results: [
						{ title: "A", url: "https://a.com" },
						{ title: "B", url: "https://b.com" },
						{ title: "A dup", url: "https://a.com" },
						{ title: "No url" },
					],
				},
			},
		]);
		expect(citations.map((c) => c.url)).toEqual([
			"https://a.com",
			"https://b.com",
		]);
		expect(citations.map((c) => c.number)).toEqual([1, 2]);
	});

	test("non-web tools yield no citations", () => {
		expect(
			extractCitations([{ type: "tool-Bash", input: { command: "ls" } }])
		).toHaveLength(0);
	});
});
