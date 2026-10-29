import { describe, expect, test } from "bun:test";
import {
	extractAtFileMentions,
	linkifyAtMentions,
} from "./linkify-mentions.ts";

describe("linkifyAtMentions", () => {
	test("expands bracketed references once and preserves filename underscores", () => {
		expect(
			linkifyAtMentions("@<note.constructor> @<note.__proto__> @<normal.pdf>")
		).toBe(
			"[@note.constructor](#ryu-file-path-note.constructor) [@note.\\_\\_proto\\_\\_](#ryu-file-path-note.__proto__) [@normal.pdf](#ryu-file-path-normal.pdf)"
		);
	});
	test("links file and website mentions", () => {
		const result = linkifyAtMentions(
			"See @src/App.tsx and @https://example.com/docs."
		);
		expect(result).toContain("[@src/App.tsx](#ryu-file-path-");
		expect(result).toContain("[@https://example.com/docs](#ryu-web-url-");
		expect(result).toEndWith(".");
	});

	test("supports paths with spaces in angle brackets", () => {
		expect(linkifyAtMentions("Open @<docs/My Guide.md>")).toContain(
			"[@docs/My Guide.md](#ryu-file-path-"
		);
	});

	test("does not rewrite code, fences, markdown links, or ordinary people", () => {
		const input =
			"@alice `@src/a.ts` [site](https://example.com)\n```ts\n@src/b.ts\n```";
		expect(linkifyAtMentions(input)).toBe(input);
	});

	test("extracts unique linked file mentions for compact preview surfaces", () => {
		expect(
			extractAtFileMentions(
				"@src/App.tsx and @<docs/My Guide.md> then @src/App.tsx"
			)
		).toEqual(["src/App.tsx", "docs/My Guide.md"]);
	});
});
