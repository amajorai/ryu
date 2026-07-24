import { describe, expect, it } from "bun:test";
import { extractCitations } from "./citations.ts";

function webFetch(input: unknown, output: unknown) {
	return { type: "tool-WebFetch", input, output };
}

function webSearch(output: unknown) {
	return { type: "tool-WebSearch", output };
}

describe("extractCitations - WebFetch", () => {
	it("builds one citation from input url + output title/summary", () => {
		const parts = [
			webFetch(
				{ url: "https://example.com/post" },
				{ title: "A Post", summary: "the summary" }
			),
		];
		expect(extractCitations(parts)).toEqual([
			{
				number: 1,
				url: "https://example.com/post",
				title: "A Post",
				description: "the summary",
			},
		]);
	});

	it("falls back to the hostname title when output has none", () => {
		const parts = [webFetch({ url: "https://www.example.com/x" }, {})];
		const [c] = extractCitations(parts);
		expect(c.title).toBe("example.com");
		expect(c.description).toBeUndefined();
	});

	it("accepts link/uri as url aliases", () => {
		expect(
			extractCitations([webFetch({ link: "https://a.io" }, {})])[0].url
		).toBe("https://a.io");
		expect(
			extractCitations([webFetch({ uri: "https://b.io" }, {})])[0].url
		).toBe("https://b.io");
	});

	it("uses a raw string output as the description", () => {
		const [c] = extractCitations([
			webFetch({ url: "https://x.io" }, "plain body text"),
		]);
		expect(c.description).toBe("plain body text");
	});

	it("parses a JSON-string output before reading fields", () => {
		const [c] = extractCitations([
			webFetch(
				{ url: "https://x.io" },
				JSON.stringify({ title: "T", text: "B" })
			),
		]);
		expect(c.title).toBe("T");
		expect(c.description).toBe("B");
	});

	it("truncates the description to 240 chars", () => {
		const long = "x".repeat(500);
		const [c] = extractCitations([webFetch({ url: "https://x.io" }, { summary: long })]);
		expect(c.description).toHaveLength(240);
	});

	it("emits nothing when there is no url", () => {
		expect(extractCitations([webFetch({}, { title: "no url" })])).toEqual([]);
	});
});

describe("extractCitations - WebSearch", () => {
	it("reads results from an object with a results array", () => {
		const parts = [
			webSearch({
				results: [
					{ url: "https://a.io", title: "A", snippet: "snip a" },
					{ link: "https://b.io", description: "desc b" },
				],
			}),
		];
		expect(extractCitations(parts)).toEqual([
			{ number: 1, url: "https://a.io", title: "A", description: "snip a" },
			{ number: 2, url: "https://b.io", title: "b.io", description: "desc b" },
		]);
	});

	it("reads results from a bare array output", () => {
		const parts = [webSearch([{ url: "https://a.io", title: "A" }])];
		expect(extractCitations(parts)).toHaveLength(1);
	});

	it("skips result entries that lack a url", () => {
		const parts = [
			webSearch({ results: [{ title: "no url" }, { url: "https://a.io" }] }),
		];
		const cs = extractCitations(parts);
		expect(cs).toHaveLength(1);
		expect(cs[0].url).toBe("https://a.io");
	});

	it("returns nothing when results is not an array", () => {
		expect(extractCitations([webSearch({ results: "nope" })])).toEqual([]);
	});
});

describe("extractCitations - aggregate behavior", () => {
	it("dedupes by url and numbers in first-seen order", () => {
		const parts = [
			webFetch({ url: "https://a.io" }, { title: "first" }),
			webSearch({ results: [{ url: "https://a.io", title: "dup" }, { url: "https://c.io" }] }),
		];
		const cs = extractCitations(parts);
		expect(cs.map((c) => c.url)).toEqual(["https://a.io", "https://c.io"]);
		expect(cs.map((c) => c.number)).toEqual([1, 2]);
		expect(cs[0].title).toBe("first");
	});

	it("ignores non-web tool parts and non-record entries", () => {
		const parts = [
			null,
			"a string",
			{ type: "tool-Bash", input: { command: "ls" } },
			webFetch({ url: "https://a.io" }, {}),
		];
		expect(extractCitations(parts)).toHaveLength(1);
	});

	it("resolves the tool name from a dynamic-tool part", () => {
		const parts = [
			{
				type: "dynamic-tool",
				toolName: "WebFetch",
				input: { url: "https://dyn.io" },
				output: {},
			},
		];
		expect(extractCitations(parts)[0].url).toBe("https://dyn.io");
	});

	it("returns an empty array when no web tools were used", () => {
		expect(extractCitations([{ type: "tool-Read" }])).toEqual([]);
	});
});
