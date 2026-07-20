import { describe, expect, it } from "bun:test";
import { formatQuotePrefix, splitLeadingQuote } from "./quote-format.ts";

describe("formatQuotePrefix", () => {
	it("prefixes a single line and adds a blank separator", () => {
		expect(formatQuotePrefix("hello world")).toBe("> hello world\n\n");
	});

	it("prefixes every line, blanks become bare >", () => {
		expect(formatQuotePrefix("a\n\nb")).toBe("> a\n>\n> b\n\n");
	});
});

describe("splitLeadingQuote", () => {
	it("returns no quote for plain text", () => {
		expect(splitLeadingQuote("just a message")).toEqual({
			quote: null,
			body: "just a message",
		});
	});

	it("peels a leading blockquote and its separator off the body", () => {
		expect(splitLeadingQuote("> quoted\n\nmy reply")).toEqual({
			quote: "quoted",
			body: "my reply",
		});
	});

	it("handles a multi-line quote", () => {
		expect(splitLeadingQuote("> line one\n> line two\n\nreply")).toEqual({
			quote: "line one\nline two",
			body: "reply",
		});
	});

	it("handles a quote with no body", () => {
		expect(splitLeadingQuote("> only a quote")).toEqual({
			quote: "only a quote",
			body: "",
		});
	});

	it("round-trips through formatQuotePrefix", () => {
		const quote = "some\nselected text";
		const body = "what does this mean?";
		const sent = `${formatQuotePrefix(quote)}${body}`;
		expect(splitLeadingQuote(sent)).toEqual({ quote, body });
	});
});
