// apps/desktop/src/lib/features.test.ts
//
// Tests for the sidebar feature-toggle store — the thin, friendly layer over the
// hidden-sections / hidden-chrome localStorage sets that Onboarding, Settings →
// Features, and the sidebar Customize dialog all read and write.
//
// Load-bearing behaviours: load/persist survive corrupt JSON (fall back to an
// empty set, never throw); `setFeatureEnabled` always reads the set FRESH before
// mutating (so a concurrent writer isn't clobbered by a stale snapshot); and
// `seedDefaultHiddenSections` hides each default-hidden section EXACTLY ONCE
// (recorded in the seeded key) so a fresh install gets them hidden while a user's
// later un-hide is never re-applied.
//
// `features.ts` runs `seedDefault*` at module load (touching localStorage), so
// register happy-dom and import it dynamically afterwards — mirroring
// `useDownloadsStore.test.ts`. Real `track()` is a no-op in test (no POSTHOG_KEY),
// so analytics is intentionally left unmocked.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof globalThis.window === "undefined") {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";

const {
	CHROME_HIDDEN_KEY,
	SECTION_HIDDEN_KEY,
	DEFAULT_HIDDEN_SECTIONS,
	isFeatureEnabled,
	loadHiddenChrome,
	loadHiddenSections,
	persistHiddenChrome,
	persistHiddenSections,
	seedDefaultHiddenSections,
	setFeatureEnabled,
} = await import("./features.ts");

const HIDDEN_SEEDED_KEY = "ryu:sidebar-hidden-seeded";

beforeEach(() => {
	localStorage.clear();
});

describe("loadHiddenSections / persistHiddenSections", () => {
	test("round-trips a set through storage as a JSON array", () => {
		persistHiddenSections(new Set(["a", "b"]));
		expect([...loadHiddenSections()].sort()).toEqual(["a", "b"]);
		expect(JSON.parse(localStorage.getItem(SECTION_HIDDEN_KEY) ?? "[]")).toEqual([
			"a",
			"b",
		]);
	});

	test("an empty / absent key reads back an empty set", () => {
		expect(loadHiddenSections().size).toBe(0);
	});

	test("corrupt JSON falls back to an empty set instead of throwing", () => {
		localStorage.setItem(SECTION_HIDDEN_KEY, "{not json");
		expect(() => loadHiddenSections()).not.toThrow();
		expect(loadHiddenSections().size).toBe(0);
	});

	test("persist fires the features-changed event so surfaces re-sync", () => {
		let fired = 0;
		const handler = () => {
			fired += 1;
		};
		window.addEventListener("ryu:features-changed", handler);
		try {
			persistHiddenSections(new Set(["x"]));
		} finally {
			window.removeEventListener("ryu:features-changed", handler);
		}
		expect(fired).toBe(1);
	});
});

describe("isFeatureEnabled", () => {
	test("a section not in the hidden set is enabled", () => {
		expect(isFeatureEnabled("meetings")).toBe(true);
	});

	test("a section in the hidden set is disabled", () => {
		persistHiddenSections(new Set(["meetings"]));
		expect(isFeatureEnabled("meetings")).toBe(false);
	});
});

describe("setFeatureEnabled", () => {
	test("disabling adds the key to the hidden section set", () => {
		setFeatureEnabled("spaces", false);
		expect(loadHiddenSections().has("spaces")).toBe(true);
		expect(isFeatureEnabled("spaces")).toBe(false);
	});

	test("enabling removes it again", () => {
		setFeatureEnabled("spaces", false);
		setFeatureEnabled("spaces", true);
		expect(loadHiddenSections().has("spaces")).toBe(false);
		expect(isFeatureEnabled("spaces")).toBe(true);
	});

	test("reads the set FRESH each call: an out-of-band hide is not clobbered", () => {
		// A concurrent writer (e.g. the Customize dialog) hides "workflows" directly.
		persistHiddenSections(new Set(["workflows"]));
		// This surface, holding no knowledge of that, disables "spaces".
		setFeatureEnabled("spaces", false);
		// Both must be hidden — the fresh read merged, it did not overwrite.
		const hidden = loadHiddenSections();
		expect(hidden.has("workflows")).toBe(true);
		expect(hidden.has("spaces")).toBe(true);
	});
});

describe("seedDefaultHiddenSections", () => {
	test("hides every default-hidden section once on a fresh install", () => {
		seedDefaultHiddenSections();
		const hidden = loadHiddenSections();
		for (const key of DEFAULT_HIDDEN_SECTIONS) {
			expect(hidden.has(key)).toBe(true);
		}
		// The seeded ledger records them so a second run is a no-op.
		expect(
			new Set(JSON.parse(localStorage.getItem(HIDDEN_SEEDED_KEY) ?? "[]")).size
		).toBe(DEFAULT_HIDDEN_SECTIONS.length);
	});

	test("does NOT re-hide a section the user has since un-hidden", () => {
		seedDefaultHiddenSections();
		// User un-hides "skills".
		const hidden = loadHiddenSections();
		hidden.delete("skills");
		persistHiddenSections(hidden);
		// A later seed run must leave the un-hide alone (skills already seeded).
		seedDefaultHiddenSections();
		expect(loadHiddenSections().has("skills")).toBe(false);
	});

	test("seeds only sections not already in the seeded ledger", () => {
		// Pretend everything but "engines" was already seeded on a prior version.
		const already = DEFAULT_HIDDEN_SECTIONS.filter((k) => k !== "engines");
		localStorage.setItem(HIDDEN_SEEDED_KEY, JSON.stringify(already));
		seedDefaultHiddenSections();
		// Only the newly-introduced "engines" gets freshly hidden.
		expect(loadHiddenSections().has("engines")).toBe(true);
		// The already-seeded ones were NOT re-added (hidden set still lacks them).
		expect(loadHiddenSections().has("meetings" as never)).toBe(false);
	});

	test("is a no-op when the ledger already covers every default", () => {
		localStorage.setItem(
			HIDDEN_SEEDED_KEY,
			JSON.stringify([...DEFAULT_HIDDEN_SECTIONS])
		);
		seedDefaultHiddenSections();
		expect(loadHiddenSections().size).toBe(0);
	});
});

describe("hidden-chrome set (parallel store)", () => {
	test("persist + load round-trips independently of the sections set", () => {
		persistHiddenChrome(new Set(["memory"]));
		expect([...loadHiddenChrome()]).toEqual(["memory"]);
		// The sections key is untouched.
		expect(localStorage.getItem(SECTION_HIDDEN_KEY)).toBeNull();
		expect(localStorage.getItem(CHROME_HIDDEN_KEY)).not.toBeNull();
	});

	test("corrupt chrome JSON falls back to an empty set", () => {
		localStorage.setItem(CHROME_HIDDEN_KEY, "@@@");
		expect(loadHiddenChrome().size).toBe(0);
	});
});
