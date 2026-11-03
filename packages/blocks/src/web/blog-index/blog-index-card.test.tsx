import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogIndexCard, BlogIndexImage } from "./blog-index-card.tsx";
import type { BlogIndexPost } from "./blog-index-model.ts";
import { BlogLeadPost } from "./blog-lead-post.tsx";

const POST: BlogIndexPost = {
	authors: [
		{ avatar: "/content/authors/ada.webp", name: "Ada Operator", slug: "ada" },
	],
	banner: "/content/blog/local-models/banner.webp",
	bannerDark: "/content/blog/local-models/banner-dark.webp",
	content: "Body text",
	date: "2026-03-15",
	description: "Run models on your own machine.",
	id: "local-models",
	slug: "local-models",
	tag: "Explainers",
	title: "Local models, explained",
};

describe("BlogIndexCard", () => {
	const html = renderToStaticMarkup(<BlogIndexCard post={POST} />);

	it("shows tag, date, title link, description, and author", () => {
		expect(html).toContain('data-slot="post-tag"');
		expect(html).toContain(">Explainers<");
		expect(html).toMatch(
			/<time[^>]*datetime="2026-03-15"[^>]*>Mar 15, 2026<\/time>/i
		);
		expect(html).toMatch(
			/<h3[^>]*><a[^>]*href="\/blog\/local-models"[^>]*>Local models, explained<\/a><\/h3>/
		);
		expect(html).toContain("Run models on your own machine.");
		expect(html).toContain('href="/blog/author/ada"');
		expect(html).toContain(">Ada Operator<");
	});

	it("never nests the author link inside the title link", () => {
		let depth = 0;
		let deepest = 0;
		for (const tag of html.matchAll(/<(\/?)a[\s>]/g)) {
			depth += tag[1] ? -1 : 1;
			deepest = Math.max(deepest, depth);
		}
		expect(depth).toBe(0);
		expect(deepest).toBe(1);
	});

	it("omits the summary when the post has no description", () => {
		const bare = renderToStaticMarkup(
			<BlogIndexCard post={{ ...POST, description: undefined }} />
		);
		expect(bare).not.toContain("line-clamp-3");
		expect(bare).not.toContain("Body text");
	});
});

describe("BlogIndexImage", () => {
	it("uses the banner with its dark copy", () => {
		const html = renderToStaticMarkup(<BlogIndexImage post={POST} />);
		expect(html).toContain("banner.webp");
		expect(html).toContain("banner-dark.webp");
	});

	it("falls back to the post's generated social card without a banner", () => {
		const html = renderToStaticMarkup(
			<BlogIndexImage
				post={{ ...POST, banner: undefined, bannerDark: undefined }}
			/>
		);
		expect(html).toContain("/blog/local-models/opengraph-image");
	});
});

describe("BlogLeadPost", () => {
	it("titles the lead with an h2 and labels it Latest when not pinned", () => {
		const html = renderToStaticMarkup(<BlogLeadPost post={POST} />);
		expect(html).toMatch(/<h2[^>]*id="blog-lead-title"/);
		expect(html).toContain(">Latest<");
		expect(html).toContain("Run models on your own machine.");
		expect(html).toContain(">Ada Operator<");
	});

	it("labels a pinned lead Pinned", () => {
		const html = renderToStaticMarkup(
			<BlogLeadPost post={{ ...POST, pinned: true }} />
		);
		expect(html).toContain(">Pinned<");
	});
});
