import { afterAll, beforeEach, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	FAVORITES_CHANGED_EVENT,
	FAVORITES_KEY,
	loadFavorites,
	loadRecents,
	RECENTS_CHANGED_EVENT,
	RECENTS_KEY,
	stampRecent,
	toggleFavorite,
} from "./library.ts";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());

it("keeps future and malformed raw favorites while exposing only complete current references", () => {
	const raw =
		'[{"type":"agent","id":"a","future":true,"__proto__":{"retained":true}},{"type":"future-kind","id":"f","metadata":{"v":2}},null,7,{"type":"chat"}]';
	localStorage.setItem(FAVORITES_KEY, raw);
	const favorites = loadFavorites();
	expect(favorites.map(({ type, id }) => ({ type, id }))).toEqual([
		{ type: "agent", id: "a" },
	]);
	expect(
		Object.getOwnPropertyDescriptor(favorites[0], "__proto__")?.value
	).toEqual({ retained: true });
	expect(localStorage.getItem(FAVORITES_KEY)).toBe(raw);
	let events = 0;
	const onChange = () => {
		events += 1;
	};
	window.addEventListener(FAVORITES_CHANGED_EVENT, onChange);
	try {
		toggleFavorite("chat", "new");
		expect(localStorage.getItem(FAVORITES_KEY)).toBe(
			`[{"type":"chat","id":"new"},${raw.slice(1)}`
		);
		toggleFavorite("agent", "a");
		expect(localStorage.getItem(FAVORITES_KEY)).toBe(
			'[{"type":"chat","id":"new"},{"type":"future-kind","id":"f","metadata":{"v":2}},null,7,{"type":"chat"}]'
		);
		expect(events).toBe(2);
	} finally {
		window.removeEventListener(FAVORITES_CHANGED_EVENT, onChange);
	}
});
it("updates the selected recent without dropping unknown items or raw metadata", () => {
	const future = {
		type: "future-kind",
		id: "future",
		ts: 3,
		metadata: { keep: true },
	};
	localStorage.setItem(
		RECENTS_KEY,
		JSON.stringify([
			{ type: "chat", id: "c", ts: 1 },
			future,
			{ type: "agent", id: "a", ts: 2, metadata: { keep: true } },
			null,
		])
	);
	expect(loadRecents().map(({ type, id }) => ({ type, id }))).toEqual([
		{ type: "chat", id: "c" },
		{ type: "agent", id: "a" },
	]);
	let events = 0;
	const onChange = () => {
		events += 1;
	};
	window.addEventListener(RECENTS_CHANGED_EVENT, onChange);
	try {
		const before = Date.now();
		stampRecent("chat", "c");
		const recents = loadRecents();
		expect(recents[0]?.ts).toBeGreaterThanOrEqual(before);
		expect(recents.map(({ id }) => id)).toEqual(["c", "a"]);
		expect(localStorage.getItem(RECENTS_KEY)).toEndWith(
			JSON.stringify([
				future,
				{ type: "agent", id: "a", ts: 2, metadata: { keep: true } },
				null,
			]).slice(1)
		);
		expect(events).toBe(1);
	} finally {
		window.removeEventListener(RECENTS_CHANGED_EVENT, onChange);
	}
});
it("retains the native sixty-entry cap and tolerates corrupt stored roots", () => {
	const entries = Array.from({ length: 70 }, (_, id) => ({
		type: "chat",
		id: String(id),
		ts: id,
	}));
	localStorage.setItem(RECENTS_KEY, JSON.stringify(entries));
	stampRecent("agent", "new");
	expect(loadRecents()).toHaveLength(60);
	expect(loadRecents()[59]?.id).toBe("58");
	for (const value of ["not-json", "null", "{}", '"legacy"']) {
		localStorage.setItem(FAVORITES_KEY, value);
		localStorage.setItem(RECENTS_KEY, value);
		expect(loadFavorites()).toEqual([]);
		expect(loadRecents()).toEqual([]);
	}
});
