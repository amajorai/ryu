import { describe, expect, it } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogIndexCard } from "./blog-index/blog-index-card.tsx";
import type { BlogIndexPost } from "./blog-index/blog-index-model.ts";
import { BlogLeadPost } from "./blog-index/blog-lead-post.tsx";
import { ChangelogFeedItem } from "./changelog-index/changelog-feed-entry.tsx";
import { DatedList } from "./page-sections/dated-list.tsx";

// The blog and changelog index dates and the dated lists (press, careers,
// events, security) read the page language from the mounted provider, so a
// Japanese, German or Arabic reader never sees "Mar 15, 2026".

const POST: BlogIndexPost = {
	authors: [],
	content: "Body text",
	date: "2026-03-15",
	id: "local-models",
	slug: "local-models",
	title: "Local models, explained",
};

function renderIn(locale: string, node: ReactNode): string {
	return renderToStaticMarkup(
		<I18nProvider initialLocale={locale} initialPackId={null}>
			{node}
		</I18nProvider>
	);
}

function timeText(html: string): string[] {
	return [...html.matchAll(/<time[^>]*>([^<]*)<\/time>/g)].map(
		(match) => match[1] ?? ""
	);
}

describe("index dates follow the page language", () => {
	it("the blog card and lead post format the date in Japanese", () => {
		expect(timeText(renderIn("ja", <BlogIndexCard post={POST} />))).toEqual([
			"2026年3月15日",
		]);
		expect(timeText(renderIn("ja", <BlogLeadPost post={POST} />))).toEqual([
			"2026年3月15日",
		]);
	});

	it("the changelog feed entry formats the release date in Japanese", () => {
		const html = renderIn(
			"ja",
			<ChangelogFeedItem
				entry={{
					content: "",
					date: "2026-03-15",
					id: "r1",
					slug: "r1",
					title: "Release r1",
					type: "Release",
					version: "",
				}}
			/>
		);
		expect(timeText(html)).toEqual(["2026年3月15日"]);
	});

	it("dated lists format days and months for German and Arabic", () => {
		const items = [
			{ id: "day", title: "Day", href: "/a", date: "2026-10-30" },
			{ id: "month", title: "Month", href: "/b", date: "2026-05" },
		];
		const list = <DatedList emptyState={null} items={items} />;
		expect(timeText(renderIn("de", list))).toEqual([
			"30. Okt. 2026",
			"Mai 2026",
		]);
		const arabic = timeText(renderIn("ar", list));
		expect(arabic).toHaveLength(2);
		for (const text of arabic) {
			expect(text).not.toMatch(/Oct|May/);
		}
		expect(renderIn("de", list)).toContain('dateTime="2026-10-30"');
	});

	it("keeps the English form without a provider", () => {
		expect(
			timeText(renderToStaticMarkup(<BlogIndexCard post={POST} />))
		).toEqual(["Mar 15, 2026"]);
	});
});
