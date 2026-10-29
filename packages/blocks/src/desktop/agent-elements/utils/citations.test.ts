import { requireTestValue } from "../../test-required.ts";
import { describe, expect, it } from "bun:test";
import { extractCitations, linkifyCitationMarkers } from "./citations.ts";

function webFetch<Input, Output>(input: Input, output: Output) {
	return { type: "tool-WebFetch", input, output };
}

function webSearch<Output>(output: Output) {
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
		if (!c) throw new Error("Expected extracted citation");
		expect(c.title).toBe("example.com");
		expect(c.description).toBeUndefined();
	});

	it("accepts link/uri as url aliases", () => {
		expect(
			requireTestValue(
				extractCitations([webFetch({ link: "https://a.io" }, {})])[0],
				"first citation"
			).url
		).toBe("https://a.io");
		expect(
			requireTestValue(
				extractCitations([webFetch({ uri: "https://b.io" }, {})])[0],
				"first citation"
			).url
		).toBe("https://b.io");
	});

	it("uses a raw string output as the description", () => {
		const [c] = extractCitations([
			webFetch({ url: "https://x.io" }, "plain body text"),
		]);
		if (!c) throw new Error("Expected extracted citation");
		expect(c.description).toBe("plain body text");
	});

	it("parses a JSON-string output before reading fields", () => {
		const [c] = extractCitations([
			webFetch(
				{ url: "https://x.io" },
				JSON.stringify({ title: "T", text: "B" })
			),
		]);
		if (!c) throw new Error("Expected extracted citation");
		expect(c.title).toBe("T");
		expect(c.description).toBe("B");
	});

	it("truncates the description to 240 chars", () => {
		const long = "x".repeat(500);
		const [c] = extractCitations([
			webFetch({ url: "https://x.io" }, { summary: long }),
		]);
		if (!c) throw new Error("Expected extracted citation");
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
		expect(requireTestValue(cs[0], "first citation").url).toBe("https://a.io");
	});

	it("returns nothing when results is not an array", () => {
		expect(extractCitations([webSearch({ results: "nope" })])).toEqual([]);
	});
});

describe("extractCitations - aggregate behavior", () => {
	it("dedupes by url and numbers in first-seen order", () => {
		const parts = [
			webFetch({ url: "https://a.io" }, { title: "first" }),
			webSearch({
				results: [
					{ url: "https://a.io", title: "dup" },
					{ url: "https://c.io" },
				],
			}),
		];
		const cs = extractCitations(parts);
		expect(cs.map((c) => c.url)).toEqual(["https://a.io", "https://c.io"]);
		expect(cs.map((c) => c.number)).toEqual([1, 2]);
		expect(requireTestValue(cs[0], "first citation").title).toBe("first");
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
		expect(
			requireTestValue(extractCitations(parts)[0], "first citation").url
		).toBe("https://dyn.io");
	});

	it("returns an empty array when no web tools were used", () => {
		expect(extractCitations([{ type: "tool-Read" }])).toEqual([]);
	});
});

describe("linkifyCitationMarkers", () => {
	const citations = [
		{
			number: 1,
			title: "Attention Is All You Need",
			url: "https://arxiv.org/abs/1706.03762",
		},
		{
			number: 2,
			title: "Efficient Transformers",
			url: "https://arxiv.org/abs/2009.06732",
		},
	];

	it("turns bare [n] into #ryu-cite-n links for known citations", () => {
		expect(
			linkifyCitationMarkers(
				"Transformers scale well[1], though attention is quadratic[2].",
				citations
			)
		).toBe(
			"Transformers scale well[1](#ryu-cite-1), though attention is quadratic[2](#ryu-cite-2)."
		);
	});

	it("leaves unknown numbers, existing links, and definitions alone", () => {
		expect(
			linkifyCitationMarkers(
				"see [9] and [1](https://x.io) and [2]:",
				citations
			)
		).toBe("see [9] and [1](https://x.io) and [2]:");
	});

	it("skips markers inside code fences and inline code", () => {
		const text = "prose [1]\n```\ncode [1]\n```\nand `[1]` stays";
		expect(linkifyCitationMarkers(text, citations)).toBe(
			"prose [1](#ryu-cite-1)\n```\ncode [1]\n```\nand `[1]` stays"
		);
	});

	it("is a no-op without citations", () => {
		expect(linkifyCitationMarkers("hello [1]", undefined)).toBe("hello [1]");
		expect(linkifyCitationMarkers("hello [1]", [])).toBe("hello [1]");
	});
});

describe("extractCitations - native carriers", () => {
	it("reads inherited fields independently without traversing unrelated metadata", () => {
		class SearchResult {
			get url() {
				return false;
			}
			get link() {
				return "https://native.example/result";
			}
			get title() {
				return " ";
			}
			get snippet() {
				return null;
			}
			get description() {
				return "native description";
			}
			get metadata() {
				throw new Error("unrelated metadata must remain unread");
			}
		}
		const rows = [new SearchResult()];
		expect(extractCitations([webSearch(rows)])).toEqual([
			{
				number: 1,
				url: "https://native.example/result",
				title: "native.example",
				description: "native description",
			},
		]);
	});

	it("retains native input getter read order and original kind reads", () => {
		let inputReads = 0;
		let kindReads = 0;
		const part = {
			get type() {
				kindReads += 1;
				return "tool-WebFetch";
			},
			get input() {
				inputReads += 1;
				return inputReads === 1
					? { url: "https://first.example" }
					: { uri: "https://second.example" };
			},
			output: { title: "Second read", summary: false, text: "fallback body" },
		};
		expect(extractCitations([part])).toEqual([
			{
				number: 1,
				url: "https://second.example",
				title: "Second read",
				description: "fallback body",
			},
		]);
		expect(inputReads).toBe(2);
		expect(kindReads).toBe(4);
	});
});
