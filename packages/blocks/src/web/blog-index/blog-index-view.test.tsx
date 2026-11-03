import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BlogIndexPost } from "./blog-index-model.ts";
import { BLOG_GRID_PAGE_SIZE, BlogIndexView } from "./blog-index-view.tsx";

function post(slug: string, date: string, pinned = false): BlogIndexPost {
	return {
		content: "",
		date,
		description: `Summary of ${slug}`,
		id: slug,
		pinned,
		slug,
		tag: "Explainers",
		title: `Post ${slug}`,
	};
}

const CHIPS = [
	{ count: 3, label: "All" },
	{ count: 2, label: "Explainers", value: "Explainers" },
	{ count: 1, label: "How-to", value: "How-to" },
];

function gridSlugs(html: string): string[] {
	return [...html.matchAll(/data-post-slug="([^"]+)"/g)].map((m) => m[1] ?? "");
}

function leadSlug(html: string): string | undefined {
	return html.match(/data-lead-slug="([^"]+)"/)?.[1];
}

describe("BlogIndexView", () => {
	it("leads with the pinned post and keeps it out of the grid", () => {
		const html = renderToStaticMarkup(
			<BlogIndexView
				chips={CHIPS}
				posts={[
					post("newest", "2026-10-01"),
					post("pinned", "2026-02-01", true),
					post("older", "2026-01-01"),
				]}
			/>
		);
		expect(leadSlug(html)).toBe("pinned");
		expect(gridSlugs(html)).toEqual(["newest", "older"]);
	});

	it("leads with the newest post when none is pinned, without repeating it", () => {
		const html = renderToStaticMarkup(
			<BlogIndexView
				chips={CHIPS}
				posts={[
					post("b", "2026-05-01"),
					post("c", "2026-09-01"),
					post("a", "2026-01-01"),
				]}
			/>
		);
		expect(leadSlug(html)).toBe("c");
		expect(gridSlugs(html)).toEqual(["b", "a"]);
		expect(html).toContain(">More posts<");
	});

	it("shows the first page of the grid and offers more", () => {
		const posts = Array.from({ length: BLOG_GRID_PAGE_SIZE + 3 }, (_, index) =>
			post(`p${index}`, `2026-01-${String(index + 1).padStart(2, "0")}`)
		);
		const html = renderToStaticMarkup(
			<BlogIndexView chips={CHIPS} posts={posts} />
		);
		expect(gridSlugs(html)).toHaveLength(BLOG_GRID_PAGE_SIZE);
		expect(html).toContain("Show more posts");
	});

	it("renders the filter chips and search, and no h1", () => {
		const html = renderToStaticMarkup(
			<BlogIndexView chips={CHIPS} posts={[post("a", "2026-01-01")]} />
		);
		expect(html).toContain('data-tag-chip="How-to"');
		expect(html).toContain('placeholder="Search posts"');
		expect(html).not.toContain("<h1");
	});

	it("mounts an empty polite search-status region before any search", () => {
		const html = renderToStaticMarkup(
			<BlogIndexView chips={CHIPS} posts={[post("a", "2026-01-01")]} />
		);
		expect(html).toContain(
			'<p aria-live="polite" class="sr-only" data-slot="search-status"></p>'
		);
	});

	it("says so when there are no posts", () => {
		const html = renderToStaticMarkup(
			<BlogIndexView chips={CHIPS} posts={[]} />
		);
		expect(html).toContain("Nothing here yet.");
		expect(leadSlug(html)).toBeUndefined();
		expect(html).not.toContain("Search posts");
	});
});
