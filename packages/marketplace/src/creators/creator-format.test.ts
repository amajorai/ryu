import { describe, expect, it } from "bun:test";
import {
	creatorHandle,
	creatorKindSummary,
	creatorLinks,
	creatorRouteHandle,
	creatorSinceLabel,
	filterListingsByKind,
	pluralCount,
} from "./creator-format.ts";

describe("creator handles", () => {
	it("prefers the slug and falls back to the id", () => {
		expect(creatorHandle({ slug: "acme" })).toBe("@acme");
		expect(creatorHandle({ slug: "  " })).toBeNull();
		expect(creatorRouteHandle({ id: "64b7", slug: "acme" })).toBe("acme");
		expect(creatorRouteHandle({ id: "64b7", slug: null })).toBe("64b7");
	});
});

describe("creatorKindSummary", () => {
	it("uses the shared kind labels and caps the list", () => {
		expect(creatorKindSummary(["skill"])).toBe("Skills");
		expect(creatorKindSummary(["agent", "skill"])).toBe(
			"Agent Templates, Skills"
		);
		expect(creatorKindSummary(["agent", "app", "mcp", "skill"])).toBe(
			"Agent Templates, Apps +2"
		);
	});
});

describe("creatorSinceLabel", () => {
	it("formats a month and year, and rejects bad input", () => {
		expect(creatorSinceLabel("2026-03-15T00:00:00Z", "en-US")).toBe(
			"Publishing since Mar 2026"
		);
		expect(creatorSinceLabel(null)).toBeNull();
		expect(creatorSinceLabel("not a date")).toBeNull();
	});
});

describe("pluralCount", () => {
	it("pluralizes and clamps", () => {
		expect(pluralCount(1, "listing")).toBe("1 listing");
		expect(pluralCount(3, "follower")).toBe("3 followers");
		expect(pluralCount(-2, "listing")).toBe("0 listings");
	});
});

describe("creatorLinks", () => {
	it("builds safe links only", () => {
		expect(
			creatorLinks({
				githubHandle: "acme-labs",
				website: "https://www.acme.dev/",
				xHandle: "acme_ai",
			})
		).toEqual([
			{ href: "https://www.acme.dev/", kind: "website", label: "acme.dev" },
			{
				href: "https://github.com/acme-labs",
				kind: "github",
				label: "acme-labs",
			},
			{ href: "https://x.com/acme_ai", kind: "x", label: "@acme_ai" },
		]);
		expect(
			creatorLinks({
				githubHandle: "../evil",
				website: "javascript:alert(1)",
				xHandle: "not/valid",
			})
		).toEqual([]);
	});
});

describe("filterListingsByKind", () => {
	it("keeps everything for all", () => {
		const listings = [{ kind: "skill" }, { kind: "agent" }];
		expect(filterListingsByKind(listings, "all")).toHaveLength(2);
		expect(filterListingsByKind(listings, "agent")).toEqual([
			{ kind: "agent" },
		]);
	});
});
