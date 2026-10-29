import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type FeaturedUpdateData,
	FeaturedUpdates,
	featuredTierAt,
} from "./featured-updates.tsx";

function item(slug: string, image?: string): FeaturedUpdateData {
	return {
		date: "2026-05-01",
		fallbackImage: `/blog/${slug}/opengraph-image`,
		href: `/blog/${slug}`,
		image,
		key: `blog:${slug}`,
		label: "Blog",
		title: `Post ${slug}`,
	};
}

describe("FeaturedUpdates", () => {
	it("renders nothing without items", () => {
		expect(renderToStaticMarkup(<FeaturedUpdates items={[]} />)).toBe("");
	});

	it("leads with one large card, pairs the next two, then rows of three", () => {
		const html = renderToStaticMarkup(
			<FeaturedUpdates
				items={["a", "b", "c", "d", "e", "f"].map((slug) => item(slug))}
			/>
		);
		const tiers = [...html.matchAll(/data-tier="(\w+)"/g)].map(
			(match) => match[1]
		);
		expect(tiers).toEqual(["lead", "pair", "pair", "trio", "trio", "trio"]);
		expect(html).toContain("md:grid-cols-6");
		expect(html).toContain("md:col-span-6");
		expect(html).toContain("md:col-span-2");
	});

	it("keeps later items in rows of three", () => {
		expect([0, 1, 2, 3, 6, 9].map(featuredTierAt)).toEqual([
			"lead",
			"pair",
			"pair",
			"trio",
			"trio",
			"trio",
		]);
	});

	it("titles cards with the heading level the page asks for", () => {
		expect(
			renderToStaticMarkup(<FeaturedUpdates items={[item("a")]} />)
		).toContain("<h3");
		expect(
			renderToStaticMarkup(<FeaturedUpdates items={[item("a")]} titleAs="h2" />)
		).toContain("<h2");
	});

	it("shows the banner when there is one and the social card otherwise", () => {
		const html = renderToStaticMarkup(
			<FeaturedUpdates
				items={[
					item("banner", "/content/blog/banner/banner.jpg"),
					item("plain"),
				]}
			/>
		);
		expect(html).toContain('src="/content/blog/banner/banner.jpg"');
		expect(html).toContain('src="/blog/plain/opengraph-image"');
		expect(html).not.toContain('src="/blog/banner/opengraph-image"');
		expect(html).toContain('alt="Post banner"');
		expect(html).toContain('alt="Post plain"');
	});

	it("drops an unsafe image URL in favour of the fallback card", () => {
		const html = renderToStaticMarkup(
			<FeaturedUpdates items={[item("unsafe", "javascript:alert(1)")]} />
		);
		expect(html).not.toContain("javascript:");
		expect(html).toContain('src="/blog/unsafe/opengraph-image"');
	});
});
