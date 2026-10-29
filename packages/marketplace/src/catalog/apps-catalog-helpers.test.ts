// Unit tests for the pure helpers behind the Apps catalog detail panel. They run
// only inside the Dialog-portaled preview (unreachable through the package's
// static-markup render idiom — see apps-catalog-render.test.tsx), so they are
// exported and exercised directly here. The security-relevant one is
// `safeHttpUrl`: it is the render guard that keeps a `javascript:`/`data:` link
// an untrusted publisher put in a manifest field out of an `<a href>`.

import { describe, expect, test } from "bun:test";
import {
	groupByCatalogSource,
	isCommunityEntry,
	isCompanionApp,
	prettyPluginId,
	priceLabel,
	runnableKindLabel,
	safeHttpUrl,
} from "./apps-catalog-section.tsx";
import type { AppCatalogItem, CatalogEntry } from "./types.ts";

function item(entry: Partial<CatalogEntry>): AppCatalogItem {
	return {
		enabled: false,
		entry: {
			description: "",
			id: "com.example.x",
			kinds: [],
			name: "X",
			tags: [],
			...entry,
		},
		grants: [],
		installed: false,
	};
}

describe("safeHttpUrl", () => {
	test("passes an http(s) URL through (normalized by URL)", () => {
		expect(safeHttpUrl("https://example.com/x")).toBe("https://example.com/x");
		expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
	});

	test("rejects the javascript: scheme", () => {
		expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
	});

	test("rejects the data: scheme", () => {
		expect(safeHttpUrl("data:text/html,<script>bad()</script>")).toBeNull();
	});

	test("rejects other non-http schemes", () => {
		expect(safeHttpUrl("ftp://host/file")).toBeNull();
		expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
		expect(safeHttpUrl("mailto:a@b.com")).toBeNull();
	});

	test("rejects a non-URL / relative string", () => {
		expect(safeHttpUrl("not a url")).toBeNull();
		expect(safeHttpUrl("/relative/path")).toBeNull();
	});

	test("null / undefined / empty resolve to null", () => {
		expect(safeHttpUrl(null)).toBeNull();
		expect(safeHttpUrl(undefined)).toBeNull();
		expect(safeHttpUrl("")).toBeNull();
	});

	test("case-variant scheme is still parsed by URL and allowed", () => {
		// URL lower-cases the protocol, so HTTPS:// is a valid https URL.
		expect(safeHttpUrl("HTTPS://Example.com")).toBe("https://example.com/");
	});
});

describe("isCompanionApp", () => {
	test("explicit type 'app' wins", () => {
		expect(isCompanionApp(item({ type: "app", kinds: [] }))).toBe(true);
	});

	test("explicit type 'plugin' wins even if kinds includes companion", () => {
		expect(isCompanionApp(item({ type: "plugin", kinds: ["companion"] }))).toBe(
			false
		);
	});

	test("legacy: no type falls back to kinds.includes('companion')", () => {
		expect(isCompanionApp(item({ kinds: ["companion", "tool"] }))).toBe(true);
		expect(isCompanionApp(item({ kinds: ["tool"] }))).toBe(false);
	});
});

describe("prettyPluginId", () => {
	test("takes the last dotted segment and capitalizes it", () => {
		expect(prettyPluginId("@ryu/spaces")).toBe("Spaces");
		expect(prettyPluginId("com.example.myTool")).toBe("MyTool");
	});

	test("an id with no dot is capitalized as-is", () => {
		expect(prettyPluginId("browser")).toBe("Browser");
	});

	test("empty string stays empty (no crash)", () => {
		expect(prettyPluginId("")).toBe("");
	});
});

describe("runnableKindLabel", () => {
	test("known kinds map to curated labels", () => {
		expect(runnableKindLabel("agent")).toBe("Agent");
		expect(runnableKindLabel("mcp")).toBe("MCP");
		expect(runnableKindLabel("workflow")).toBe("Workflow");
	});

	test("unknown kind falls back to a capitalized word", () => {
		expect(runnableKindLabel("gizmo")).toBe("Gizmo");
	});
});

// The highest-consequence contract in the community-listings feature: the
// discriminator must be read off the SAME snake_case key Core stamps. A camelCase
// spelling (or a dropped field) reads as undefined → first-party → an unreviewed
// third-party listing rendered with no trust notice at all, which is worse than
// not shipping the section.
describe("isCommunityEntry", () => {
	test("true for the snake_case `origin` Core emits", () => {
		expect(isCommunityEntry(item({ origin: "community" }))).toBe(true);
	});

	test("true for an explicit reviewed:false, even without `origin`", () => {
		expect(isCommunityEntry(item({ reviewed: false }))).toBe(true);
	});

	test("false when neither flag is present (old wire ⇒ first-party)", () => {
		expect(isCommunityEntry(item({}))).toBe(false);
		expect(isCommunityEntry(item({ origin: null }))).toBe(false);
		expect(isCommunityEntry(item({ origin: "first_party" }))).toBe(false);
	});

	test("a camelCase spelling does NOT satisfy the predicate", () => {
		// Guards the casing contract: if Core ever emitted `Origin`/`isCommunity`
		// instead, this must stay false so the mismatch surfaces as a test failure
		// rather than as a silently missing notice in production.
		const camel = item({});
		Object.assign(camel.entry, { communityOrigin: "community" });
		expect(isCommunityEntry(camel)).toBe(false);
	});

	test("a community listing is never also classified as a first-party app", () => {
		// `type: "app"` is what would otherwise put it in the Apps section.
		const community = item({ origin: "community", type: "app" });
		expect(isCompanionApp(community)).toBe(true);
		expect(isCommunityEntry(community)).toBe(true);
		// The section filter excludes it from apps/plugins/all on the strength of
		// isCommunityEntry alone — see `visibleItems` in apps-catalog-section.tsx.
	});
});

// The unified first-party view interleaves the FREE git catalog with the PAID
// hosted listings, so "is this paid, and how much" has to be readable off the card
// itself. Free is encoded as an ABSENT `pricing` — the shape the hosted catalog
// actually emits — which is why absence and zero must both read as free rather than
// as a "$0.00" badge.
describe("priceLabel", () => {
	test("formats a paid listing's amount in its currency", () => {
		expect(
			priceLabel(
				item({ pricing: { amountMinor: 1500, currency: "usd" } }).entry
			)
		).toBe("$15.00");
	});

	test("defaults to USD when the currency is omitted", () => {
		expect(priceLabel(item({ pricing: { amountMinor: 999 } }).entry)).toBe(
			"$9.99"
		);
	});

	test("null for a free listing (absent, null, or zero pricing)", () => {
		expect(priceLabel(item({}).entry)).toBeNull();
		expect(priceLabel(item({ pricing: null }).entry)).toBeNull();
		expect(priceLabel(item({ pricing: { amountMinor: 0 } }).entry)).toBeNull();
	});

	test("null when the amount is not a number (malformed upstream card)", () => {
		const malformed = item({});
		Object.assign(malformed.entry, { pricing: { amountMinor: "1500" } });
		expect(priceLabel(malformed.entry)).toBeNull();
	});
});

describe("groupByCatalogSource", () => {
	const row = (id: string, sourceId?: string, sourceName?: string) =>
		item({
			id,
			catalog_source_id: sourceId,
			catalog_source_name: sourceName,
		});

	test("groups rows under the marketplace that served them", () => {
		const sections = groupByCatalogSource([
			row("a", "ryu-catalog", "Ryu Marketplace"),
			row("b", "integrations-sh", "integrations.sh"),
			row("c", "ryu-catalog", "Ryu Marketplace"),
		]);
		expect(sections).toHaveLength(2);
		expect(sections[0]?.label).toBe("Ryu Marketplace");
		expect(sections[0]?.items.map((i) => i.entry.id)).toEqual(["a", "c"]);
		expect(sections[1]?.label).toBe("integrations.sh");
		expect(sections[1]?.items.map((i) => i.entry.id)).toEqual(["b"]);
	});

	test("keeps Core's emitted order rather than sorting the headings", () => {
		// Core emits the unified first-party view first on purpose; re-sorting
		// alphabetically would bury it under any marketplace named "Acme".
		const sections = groupByCatalogSource([
			row("a", "zeta-market", "Zeta"),
			row("b", "acme-market", "Acme"),
		]);
		expect(sections.map((s) => s.label)).toEqual(["Zeta", "Acme"]);
	});

	test("folds unstamped rows into one labelled bucket instead of dropping them", () => {
		const sections = groupByCatalogSource([row("a"), row("b")]);
		expect(sections).toHaveLength(1);
		expect(sections[0]?.label).toBe("Other marketplaces");
		expect(sections[0]?.items).toHaveLength(2);
	});

	test("a single marketplace yields a single section (the caller then stays flat)", () => {
		const sections = groupByCatalogSource([
			row("a", "ryu-catalog", "Ryu Marketplace"),
			row("b", "ryu-catalog", "Ryu Marketplace"),
		]);
		expect(sections).toHaveLength(1);
	});
});
