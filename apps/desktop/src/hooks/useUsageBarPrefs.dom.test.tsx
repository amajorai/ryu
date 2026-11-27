import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { UsageBarPrefs } from "./useUsageBarPrefs.ts";

// The usage preferences moved from six fields to two when the per bot meters
// gave way to the rings at the side. A value stored by the older app must load
// with the user's choices intact.

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const KEY = "ryu:usage-bar-prefs";
let load = 0;

/** A fresh load of the store module, as the app does on start. */
async function freshStore() {
	load += 1;
	const store: typeof import("./useUsageBarPrefs.ts") = await import(
		`./useUsageBarPrefs.ts?migration=${load}`
	);
	return store;
}

async function readPrefs(
	store: Awaited<ReturnType<typeof freshStore>>
): Promise<UsageBarPrefs | null> {
	let prefs: UsageBarPrefs | null = null;
	function Reader() {
		prefs = store.useUsageBarPrefs();
		return null;
	}
	const root = createRoot(document.createElement("div"));
	await act(() => root.render(<Reader />));
	await act(() => root.unmount());
	return prefs;
}

function stored(): unknown {
	return JSON.parse(localStorage.getItem(KEY) ?? "null");
}

afterEach(() => {
	localStorage.clear();
});

test("with nothing stored the rings show and a percentage reads as used", async () => {
	const store = await freshStore();
	expect(await readPrefs(store)).toEqual({ mode: "used", sidebar: true });
});

test("a user who had turned the sidebar meter off stays off", async () => {
	localStorage.setItem(
		KEY,
		JSON.stringify({
			barStyle: "bar",
			mode: "remaining",
			showBar: true,
			showPercent: true,
			sidebar: false,
			visible: true,
		})
	);
	const store = await freshStore();
	expect(await readPrefs(store)).toEqual({ mode: "remaining", sidebar: false });
});

test("hiding the old composer meter does not hide the rings", async () => {
	localStorage.setItem(
		KEY,
		JSON.stringify({ mode: "used", sidebar: true, visible: false })
	);
	const store = await freshStore();
	expect(await readPrefs(store)).toEqual({ mode: "used", sidebar: true });
});

test("an old value with no sidebar choice takes the default", async () => {
	localStorage.setItem(KEY, JSON.stringify({ visible: true, showBar: false }));
	const store = await freshStore();
	expect(await readPrefs(store)).toEqual({ mode: "used", sidebar: true });
});

test("a write keeps the old fields for an older app on a synced device", async () => {
	localStorage.setItem(
		KEY,
		JSON.stringify({
			barStyle: "ring",
			mode: "used",
			showBar: true,
			showPercent: false,
			sidebar: true,
			visible: false,
		})
	);
	const store = await freshStore();
	act(() => store.setUsageBarPrefs({ sidebar: false }));
	expect(stored()).toEqual({
		barStyle: "ring",
		mode: "used",
		showBar: true,
		showPercent: false,
		sidebar: false,
		visible: false,
	});
	expect(await readPrefs(store)).toEqual({ mode: "used", sidebar: false });
});

test("a reset restores both choices and stores only what it owns on a clean key", async () => {
	const store = await freshStore();
	act(() => store.setUsageBarPrefs({ mode: "remaining", sidebar: false }));
	expect(stored()).toEqual({ mode: "remaining", sidebar: false });
	act(() => store.resetUsageBarPrefs());
	expect(stored()).toEqual({ mode: "used", sidebar: true });
	expect(await readPrefs(store)).toEqual({ mode: "used", sidebar: true });
});

test("an unreadable stored value falls back to the defaults", async () => {
	localStorage.setItem(KEY, "{not json");
	expect(await readPrefs(await freshStore())).toEqual({
		mode: "used",
		sidebar: true,
	});
	localStorage.setItem(KEY, JSON.stringify({ mode: 7, sidebar: "no" }));
	expect(await readPrefs(await freshStore())).toEqual({
		mode: "used",
		sidebar: true,
	});
});
