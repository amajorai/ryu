// Unit tests for the pure helpers behind the Apps catalog detail panel. They run
// only inside the Dialog-portaled preview (unreachable through the package's
// static-markup render idiom — see apps-catalog-render.test.tsx), so they are
// exported and exercised directly here. The security-relevant one is
// `safeHttpUrl`: it is the render guard that keeps a `javascript:`/`data:` link
// an untrusted publisher put in a manifest field out of an `<a href>`.

import { describe, expect, test } from "bun:test";
import {
	isCommunityEntry,
	isCompanionApp,
	prettyPluginId,
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
		expect(prettyPluginId("com.ryu.spaces")).toBe("Spaces");
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
		(camel.entry as unknown as Record<string, unknown>).communityOrigin =
			"community";
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
