import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { itemMeta } from "./HelpSubmenu-item-meta.ts";

// The caption joins its parts with " · " into one text node the DOM localizer
// cannot match, so "Blog" and "Changelog" were English in every locale.
const GERMAN: Record<string, string> = {
	Blog: "Blogbeitrag",
	Changelog: "Änderungsprotokoll",
};
const tl: LiteralMessage = (source) => GERMAN[source] ?? source;

describe("What's new caption", () => {
	test("the changelog label is translated before the join", () => {
		expect(
			itemMeta(
				{
					date: "not a date",
					id: "c1",
					kind: "changelog",
					slug: "v1",
					title: "Release",
					type: "release",
					version: "1.2.0",
				},
				tl
			)
		).toBe("Änderungsprotokoll · v1.2.0");
	});

	test("an untagged blog post shows the translated fallback label", () => {
		expect(
			itemMeta(
				{ date: "not a date", id: "b1", kind: "blog", slug: "a", title: "A" },
				tl
			)
		).toBe("Blogbeitrag");
		expect(
			itemMeta(
				{
					date: "not a date",
					id: "b2",
					kind: "blog",
					slug: "b",
					tag: "Guides",
					title: "B",
				},
				tl
			)
		).toBe("Guides");
	});
});
