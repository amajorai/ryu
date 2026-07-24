// apps/desktop/src/lib/library-store.test.ts
//
// Tests for the Library favorites + recents store (the localStorage-backed side
// of `lib/library.ts`; the pure `normalizeTimestamp` half is covered in
// `library.test.ts`). These functions decide what shows on the Library page's
// Pinned and Recents rails, so their de-dup, ordering, trim-to-limit and
// route→ref mapping are load-bearing: a broken `stampRecentFromPath` would
// mis-file or silently drop "recently visited" items.
//
// A real DOM (localStorage + CustomEvent) is required; register happy-dom
// before importing the module under test.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom registers a single global DOM per process; when several test files
// register it in one `bun test` run, the later calls throw "already registered".
// Guard so any file can be run alone or alongside the others.
if (typeof globalThis.window === "undefined") {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";
import {
	FAVORITES_KEY,
	isFavorite,
	loadFavorites,
	loadRecents,
	RECENTS_KEY,
	type RecentEntry,
	refKey,
	stampRecent,
	stampRecentFromPath,
	toggleFavorite,
} from "./library.ts";

beforeEach(() => {
	localStorage.clear();
});

describe("refKey", () => {
	test("joins type and id with a colon", () => {
		expect(refKey("agent", "abc")).toBe("agent:abc");
	});

	test("distinguishes same id across types", () => {
		expect(refKey("chat", "1")).not.toBe(refKey("workflow", "1"));
	});
});

describe("isFavorite", () => {
	const favs = [
		{ type: "agent" as const, id: "a" },
		{ type: "chat" as const, id: "b" },
	];

	test("true only on an exact type+id match", () => {
		expect(isFavorite(favs, "agent", "a")).toBe(true);
		expect(isFavorite(favs, "chat", "b")).toBe(true);
	});

	test("false when id matches but type differs", () => {
		// Same id "a" but under a different type is NOT a match.
		expect(isFavorite(favs, "chat", "a")).toBe(false);
	});

	test("false on empty list", () => {
		expect(isFavorite([], "agent", "a")).toBe(false);
	});
});

describe("toggleFavorite", () => {
	test("adds an unfavorited item to the FRONT of the list", () => {
		toggleFavorite("agent", "a");
		toggleFavorite("chat", "b");
		// Most-recently toggled sits first.
		expect(loadFavorites()).toEqual([
			{ type: "chat", id: "b" },
			{ type: "agent", id: "a" },
		]);
	});

	test("toggling an existing favorite removes it", () => {
		toggleFavorite("agent", "a");
		toggleFavorite("agent", "a");
		expect(loadFavorites()).toEqual([]);
	});

	test("removal targets only the exact type+id, leaving same-id-different-type", () => {
		toggleFavorite("agent", "x");
		toggleFavorite("chat", "x");
		toggleFavorite("agent", "x"); // remove the agent one only
		expect(loadFavorites()).toEqual([{ type: "chat", id: "x" }]);
	});

	test("persists to the documented storage key as a JSON array", () => {
		toggleFavorite("space", "s1");
		const raw = localStorage.getItem(FAVORITES_KEY);
		expect(JSON.parse(raw ?? "null")).toEqual([{ type: "space", id: "s1" }]);
	});
});

describe("loadFavorites resilience", () => {
	test("returns [] when nothing is stored", () => {
		expect(loadFavorites()).toEqual([]);
	});

	test("returns [] when the stored value is not an array", () => {
		localStorage.setItem(FAVORITES_KEY, JSON.stringify({ nope: 1 }));
		expect(loadFavorites()).toEqual([]);
	});

	test("returns [] on corrupt JSON instead of throwing", () => {
		localStorage.setItem(FAVORITES_KEY, "{broken");
		expect(loadFavorites()).toEqual([]);
	});
});

describe("stampRecent", () => {
	test("prepends the newly opened item, most-recent first", () => {
		stampRecent("chat", "1");
		stampRecent("workflow", "2");
		expect(loadRecents().map((e) => e.id)).toEqual(["2", "1"]);
	});

	test("re-opening an item de-dupes and moves it to the front", () => {
		stampRecent("chat", "1");
		stampRecent("chat", "2");
		stampRecent("chat", "1"); // touch "1" again
		const ids = loadRecents().map((e) => e.id);
		expect(ids).toEqual(["1", "2"]);
		// exactly one entry for "1" (de-duped, not duplicated)
		expect(ids.filter((id) => id === "1")).toHaveLength(1);
	});

	test("stamps a timestamp on the entry", () => {
		const before = Date.now();
		stampRecent("meeting", "m");
		const [entry] = loadRecents();
		expect(entry.ts).toBeGreaterThanOrEqual(before);
	});

	test("an empty id is ignored (no entry recorded)", () => {
		stampRecent("chat", "");
		expect(loadRecents()).toEqual([]);
	});

	test("trims to the 60-entry limit, dropping the oldest", () => {
		for (let i = 0; i < 65; i++) {
			stampRecent("chat", `c${i}`);
		}
		const recents = loadRecents();
		expect(recents).toHaveLength(60);
		// Newest (c64) is first; the five oldest (c0..c4) fell off the end.
		expect(recents[0].id).toBe("c64");
		expect(recents.some((e) => e.id === "c0")).toBe(false);
		expect(recents.some((e) => e.id === "c4")).toBe(false);
		expect(recents.some((e) => e.id === "c5")).toBe(true);
	});
});

describe("stampRecentFromPath route → ref mapping", () => {
	function ids(): { type: string; id: string }[] {
		return loadRecents().map((e) => ({ type: e.type, id: e.id }));
	}

	test("/chat stamps the conversation id when provided", () => {
		stampRecentFromPath("/chat", "conv-1");
		expect(ids()).toEqual([{ type: "chat", id: "conv-1" }]);
	});

	test("/chat without a conversation id records nothing", () => {
		stampRecentFromPath("/chat");
		expect(loadRecents()).toEqual([]);
	});

	test("/agents/:id/edit maps to an agent ref", () => {
		stampRecentFromPath("/agents/agent-9/edit");
		expect(ids()).toEqual([{ type: "agent", id: "agent-9" }]);
	});

	test("/agents/new/edit is skipped (no real item yet)", () => {
		stampRecentFromPath("/agents/new/edit");
		expect(loadRecents()).toEqual([]);
	});

	test("/workflows/:id maps to a workflow ref, but /workflows/new is skipped", () => {
		stampRecentFromPath("/workflows/wf-7");
		stampRecentFromPath("/workflows/new");
		expect(ids()).toEqual([{ type: "workflow", id: "wf-7" }]);
	});

	test("/meetings/:id maps to a meeting ref", () => {
		stampRecentFromPath("/meetings/m-3");
		expect(ids()).toEqual([{ type: "meeting", id: "m-3" }]);
	});

	test("strips the query string before matching", () => {
		stampRecentFromPath("/agents/a-42/edit?tab=tools");
		expect(ids()).toEqual([{ type: "agent", id: "a-42" }]);
	});

	test("an unmapped route (e.g. /spaces) records nothing", () => {
		stampRecentFromPath("/spaces");
		stampRecentFromPath("/settings/appearance");
		expect(loadRecents()).toEqual([]);
	});
});

describe("loadRecents resilience", () => {
	test("returns [] on corrupt JSON", () => {
		localStorage.setItem(RECENTS_KEY, "not json");
		expect(loadRecents()).toEqual([]);
	});

	test("returns [] when the stored value is not an array", () => {
		localStorage.setItem(
			RECENTS_KEY,
			JSON.stringify(42 as unknown as RecentEntry[])
		);
		expect(loadRecents()).toEqual([]);
	});
});
