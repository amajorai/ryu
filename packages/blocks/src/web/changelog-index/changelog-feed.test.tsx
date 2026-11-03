import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangelogFeed, MIN_SEARCHABLE_RELEASES } from "./changelog-feed.tsx";
import { ChangelogFeedItem } from "./changelog-feed-entry.tsx";
import type { ChangelogFeedEntry } from "./changelog-feed-model.ts";

const DOCS = "https://docs.example.test/docs/release-notes";

function release(
	slug: string,
	date: string,
	extra: Partial<ChangelogFeedEntry> = {}
): ChangelogFeedEntry {
	return {
		content: "",
		date,
		id: slug,
		slug,
		title: `Release ${slug}`,
		type: "Release",
		version: "",
		...extra,
	};
}

function releaseSlugs(html: string): string[] {
	return [...html.matchAll(/data-release-slug="([^"]+)"/g)].map(
		(m) => m[1] ?? ""
	);
}

describe("ChangelogFeed", () => {
	const html = renderToStaticMarkup(
		<ChangelogFeed
			entries={[
				release("first", "2026-06-24", { version: "0.0.1" }),
				release("latest", "2026-10-30", {
					summary: "Languages and model routing.",
					version: "0.5.0",
				}),
				release("note", "2026-08-01", { type: "announcement" }),
			]}
			olderReleasesHref={DOCS}
		/>
	);

	it("lists releases newest first, each with a machine-readable date", () => {
		expect(releaseSlugs(html)).toEqual(["latest", "note", "first"]);
		const times = [
			...html.matchAll(/<time[^>]*datetime="([^"]+)"[^>]*>([^<]+)</gi),
		];
		expect(times.map((m) => [m[1], m[2]])).toEqual([
			["2026-10-30", "October 30, 2026"],
			["2026-08-01", "August 1, 2026"],
			["2026-06-24", "June 24, 2026"],
		]);
	});

	it("shows a version chip only for releases that have a version", () => {
		const chips = [
			...html.matchAll(/data-slot="version-chip"[^>]*>([^<]+)</g),
		].map((m) => m[1]);
		expect(chips).toEqual(["v0.5.0", "v0.0.1"]);
		expect(html).toContain("/tag/v0.5.0");
	});

	it("shows every release's type chip, its title link, and its summary", () => {
		const types = [
			...html.matchAll(/data-slot="type-chip"[^>]*>([^<]+)</g),
		].map((m) => m[1]);
		expect(types).toEqual(["Release", "announcement", "Release"]);
		expect(html).toMatch(
			/<h2[^>]*><a[^>]*href="\/changelog\/latest"[^>]*>Release latest<\/a><\/h2>/
		);
		expect(html).toContain("Languages and model routing.");
		expect(html).not.toContain("<h1");
	});

	it("closes with an Older releases link to the docs release notes", () => {
		expect(html).toMatch(
			new RegExp(
				`data-slot="older-releases" href="${DOCS}" rel="noopener noreferrer" target="_blank"`
			)
		);
		expect(html).toContain("Older releases");
	});

	it("offers search only once there are enough releases", () => {
		expect(html).not.toContain("Search releases");
		const many = Array.from({ length: MIN_SEARCHABLE_RELEASES }, (_, i) =>
			release(`r${i}`, `2026-0${i + 1}-01`)
		);
		expect(
			renderToStaticMarkup(
				<ChangelogFeed entries={many} olderReleasesHref={DOCS} />
			)
		).toContain("Search releases");
	});

	it("mounts an empty polite search-status region and centres the timeline dot on the scale", () => {
		expect(html).toContain(
			'<p aria-live="polite" class="sr-only" data-slot="search-status"></p>'
		);
		expect(html).toContain("-start-1.25");
		expect(html).not.toContain("-start-[5px]");
	});

	it("still links older releases when there are none here", () => {
		const empty = renderToStaticMarkup(
			<ChangelogFeed entries={[]} olderReleasesHref={DOCS} />
		);
		expect(empty).toContain("No releases yet.");
		expect(empty).toContain("Older releases");
	});
});

describe("ChangelogFeedItem", () => {
	it("hides the banner link from assistive tech, since the title already links", () => {
		const html = renderToStaticMarkup(
			<ChangelogFeedItem
				entry={release("art", "2026-10-30", {
					banner: "/content/changelog/art/banner.webp",
				})}
			/>
		);
		expect(html).toMatch(
			/<a aria-hidden="true"[^>]*tabindex="-1"[^>]*href="\/changelog\/art"/i
		);
		expect(html).toContain("banner.webp");
	});
});
