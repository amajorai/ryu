import { describe, expect, it } from "bun:test";
import {
	type ChangelogFeedEntry,
	newestReleasesFirst,
	releaseMatchesQuery,
	versionLabel,
} from "./changelog-feed-model.ts";

function release(slug: string, date: string, version = ""): ChangelogFeedEntry {
	return {
		content: "",
		date,
		id: slug,
		slug,
		title: slug,
		type: "Release",
		version,
	};
}

describe("changelog feed model", () => {
	it("orders releases newest first", () => {
		const ordered = newestReleasesFirst([
			release("a", "2026-06-24"),
			release("c", "2026-10-30"),
			release("b", "2026-09-18"),
		]);
		expect(ordered.map((entry) => entry.slug)).toEqual(["c", "b", "a"]);
	});

	it("labels a version once with a v prefix, and nothing without one", () => {
		expect(versionLabel("0.5.0")).toBe("v0.5.0");
		expect(versionLabel("v0.5.0")).toBe("v0.5.0");
		expect(versionLabel("")).toBeUndefined();
		expect(versionLabel(undefined)).toBeUndefined();
	});

	it("matches title, summary, version, and type", () => {
		const entry = {
			...release("Ryu 0.5.0", "2026-10-30", "0.5.0"),
			summary: "Voice Studio",
		};
		for (const query of ["ryu", "voice", "0.5", "release"]) {
			expect(releaseMatchesQuery(entry, query)).toBe(true);
		}
		expect(releaseMatchesQuery(entry, "kubernetes")).toBe(false);
	});
});
