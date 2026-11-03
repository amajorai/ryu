import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogTagFilter } from "./blog-tag-filter.tsx";

const CHIPS = [
	{ count: 7, label: "All" },
	{ count: 4, label: "Comparisons", value: "Comparisons" },
	{ count: 3, label: "How-to", value: "How-to" },
];

function chipCounts(html: string): Record<string, string> {
	return Object.fromEntries(
		[
			...html.matchAll(
				/data-tag-chip="([^"]+)"[^>]*>([^<]+)<span[^>]*data-slot="tag-count"[^>]*>(\d+)</g
			),
		].map((match) => [match[1], match[3]])
	);
}

describe("BlogTagFilter", () => {
	it("prints each chip's count and links it to its ?tag= view", () => {
		const html = renderToStaticMarkup(<BlogTagFilter chips={CHIPS} />);
		expect(chipCounts(html)).toEqual({
			all: "7",
			Comparisons: "4",
			"How-to": "3",
		});
		expect(html).toContain('href="/blog?tag=How-to"');
		expect(html).toContain('href="/blog"');
		expect(html).toContain('aria-label="Filter posts by tag"');
	});

	it("marks only the active tag as the current page", () => {
		const html = renderToStaticMarkup(
			<BlogTagFilter activeTag="Comparisons" chips={CHIPS} />
		);
		expect(html.match(/aria-current="page"/g)).toHaveLength(1);
		expect(html).toMatch(/aria-current="page"[^>]*data-tag-chip="Comparisons"/);
	});

	it("marks All as current on the unfiltered index", () => {
		const html = renderToStaticMarkup(<BlogTagFilter chips={CHIPS} />);
		expect(html).toMatch(/aria-current="page"[^>]*data-tag-chip="all"/);
	});

	it("renders nothing when there is only one tag to pick", () => {
		expect(
			renderToStaticMarkup(<BlogTagFilter chips={CHIPS.slice(0, 2)} />)
		).toBe("");
	});
});
