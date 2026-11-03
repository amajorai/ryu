import { describe, expect, it } from "bun:test";
import {
	type BlogIndexPost,
	buildTagChips,
	countPostsByTag,
	newestFirst,
	pickLeadPost,
	postMatchesQuery,
} from "./blog-index-model.ts";

function post(
	slug: string,
	date: string,
	extra: Partial<BlogIndexPost> = {}
): BlogIndexPost {
	return { content: "", date, id: slug, slug, title: `Post ${slug}`, ...extra };
}

describe("pickLeadPost", () => {
	it("leads with the newest pinned post, even when newer posts exist", () => {
		const posts = [
			post("newest", "2026-10-30"),
			post("old-pin", "2026-01-01", { pinned: true }),
			post("new-pin", "2026-06-01", { pinned: true }),
		];
		expect(pickLeadPost(posts)?.slug).toBe("new-pin");
	});

	it("falls back to the newest post when nothing is pinned, whatever the input order", () => {
		const posts = [
			post("a", "2026-03-01"),
			post("c", "2026-10-01"),
			post("b", "2026-05-01"),
		];
		expect(pickLeadPost(posts)?.slug).toBe("c");
		expect(newestFirst(posts).map((p) => p.slug)).toEqual(["c", "b", "a"]);
	});

	it("is undefined for no posts", () => {
		expect(pickLeadPost([])).toBeUndefined();
	});
});

describe("tag counts and chips", () => {
	const posts = [
		post("a", "2026-01-01", { tag: "Comparisons" }),
		post("b", "2026-01-02", { tag: "Comparisons" }),
		post("c", "2026-01-03", { tag: "How-to" }),
		post("d", "2026-01-04", { tag: "Zines" }),
		post("e", "2026-01-05"),
	];

	it("counts every tagged post once", () => {
		expect(countPostsByTag(posts)).toEqual({
			Comparisons: 2,
			"How-to": 1,
			Zines: 1,
		});
	});

	it("lists All with the total, known tags in BLOG_TAGS order, then unknown tags", () => {
		const chips = buildTagChips(countPostsByTag(posts), posts.length);
		expect(chips).toEqual([
			{ count: 5, label: "All" },
			{ count: 2, label: "Comparisons", value: "Comparisons" },
			{ count: 1, label: "How-to", value: "How-to" },
			{ count: 1, label: "Zines", value: "Zines" },
		]);
	});
});

describe("postMatchesQuery", () => {
	const target = post("x", "2026-01-01", {
		authors: [{ name: "Ada Operator", slug: "ada" }],
		description: "Local models on your laptop",
		tag: "Explainers",
	});

	it("matches title, description, tag, and author case-insensitively", () => {
		for (const query of ["post x", "LAPTOP", "explain", "ada"]) {
			expect(postMatchesQuery(target, query)).toBe(true);
		}
		expect(postMatchesQuery(target, "kubernetes")).toBe(false);
	});

	it("matches everything for a blank query", () => {
		expect(postMatchesQuery(target, "   ")).toBe(true);
	});
});
