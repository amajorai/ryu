// apps/desktop/src/store/useProjectDockStore.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	restoreDockTabKind,
	serializeRestoredDockTab,
} from "../components/panels/dock-panels.ts";
import {
	hydrateProjectDockTabs,
	useProjectDockStore,
	visibleProjectDockTabs,
} from "./useProjectDockStore.ts";

const STORAGE_KEY = "ryu_pinned_dock_tabs";
const originalStorageDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
);

beforeEach(() => {
	const values = new Map<string, string>();
	const storage: Storage = {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => values.delete(key),
		setItem: (key, value) => values.set(key, value),
	};
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	useProjectDockStore.setState({ byFolder: {} });
});

afterEach(() => {
	if (originalStorageDescriptor) {
		Object.defineProperty(
			globalThis,
			"localStorage",
			originalStorageDescriptor
		);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});

describe("useProjectDockStore", () => {
	test("pinning makes a tab visible to every chat in the folder", () => {
		const folder = "/tmp/proj";
		const entry = useProjectDockStore.getState().addTab(folder, {
			kind: "terminal",
			label: "Terminal",
			side: "bottom",
			pinned: false,
			ownerTabId: "chat-a",
		});

		expect(
			visibleProjectDockTabs(
				useProjectDockStore.getState().byFolder[folder] ?? [],
				"bottom",
				"chat-b"
			)
		).toEqual([]);

		useProjectDockStore.getState().togglePin(folder, entry.uid);

		const visible = visibleProjectDockTabs(
			useProjectDockStore.getState().byFolder[folder] ?? [],
			"bottom",
			"chat-b"
		);
		expect(visible).toHaveLength(1);
		expect(visible[0]?.uid).toBe(entry.uid);
		expect(visible[0]?.pinned).toBe(true);
	});

	test("clearOwner drops unpinned tabs but keeps pinned ones", () => {
		const folder = "/tmp/proj";
		const unpinned = useProjectDockStore.getState().addTab(folder, {
			kind: "terminal",
			label: "Terminal",
			side: "bottom",
			pinned: false,
			ownerTabId: "chat-a",
		});
		const pinned = useProjectDockStore.getState().addTab(folder, {
			kind: "files",
			label: "Files",
			side: "right",
			pinned: true,
			ownerTabId: "chat-a",
		});

		useProjectDockStore.getState().clearOwner(folder, "chat-a");
		const left = useProjectDockStore.getState().byFolder[folder] ?? [];
		expect(left.map((t) => t.uid)).toEqual([pinned.uid]);
		expect(left.some((t) => t.uid === unpinned.uid)).toBe(false);
	});
});

describe("pinned dock persistence", () => {
	test("persists UI identity and restores the same UID with fresh ownership", () => {
		const folder = "/tmp/proj";
		const tab = useProjectDockStore.getState().addTab(folder, {
			uid: "saved-terminal",
			kind: "terminal",
			label: "Renamed terminal",
			side: "right",
			pinned: true,
			ownerTabId: "chat-a",
		});
		const expected = {
			[folder]: [
				{ uid: tab.uid, kind: tab.kind, label: tab.label, side: tab.side },
			],
		};
		expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(expected));
		const restored = hydrateProjectDockTabs();
		expect(restored[folder]).toEqual([{ ...tab, ownerTabId: "" }]);
		expect(hydrateProjectDockTabs()).toEqual(restored);
		expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(expected));
	});

	test("migrates legacy pins once and reads back the exact saved identities", () => {
		const folder = "/tmp/legacy";
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				[folder]: [
					{ kind: "terminal", label: "Terminal", side: "bottom" },
					{ kind: "route:/store", label: "Store", side: "right" },
				],
			})
		);
		const restored = hydrateProjectDockTabs();
		const tabs = restored[folder] ?? [];
		expect(tabs).toHaveLength(2);
		expect(tabs[0]?.uid).toMatch(/^project-dock-/);
		expect(tabs[1]?.uid).not.toBe(tabs[0]?.uid);
		const expected = {
			[folder]: tabs.map(({ uid, kind, label, side }) => ({
				uid,
				kind,
				label,
				side,
			})),
		};
		expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(expected));
		expect(hydrateProjectDockTabs()).toEqual(restored);
	});

	test("repairs duplicate and malformed identities while keeping valid pins", () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				"/tmp/a": [
					{ uid: "same", kind: "terminal", label: "First", side: "bottom" },
					{ uid: "same", kind: "terminal", label: "Second", side: "right" },
					{ uid: 42, kind: "files", label: "Files", side: "right" },
					{ uid: "  ", kind: "terminal", label: "Blank UID", side: "bottom" },
				],
				"/tmp/b": [
					{
						uid: "same",
						kind: "terminal",
						label: "Other project",
						side: "bottom",
					},
				],
			})
		);
		const restored = hydrateProjectDockTabs();
		const tabs = Object.values(restored).flat();
		expect(tabs).toHaveLength(5);
		expect(tabs[0]?.uid).toBe("same");
		expect(new Set(tabs.map((tab) => tab.uid)).size).toBe(5);
		expect(tabs.every((tab) => tab.uid.trim().length > 0)).toBe(true);
		expect(hydrateProjectDockTabs()).toEqual(restored);
	});

	test("does not overwrite wholly malformed storage during recovery", () => {
		for (const raw of [
			"{broken",
			"null",
			"42",
			"[]",
			'[{"kind":"terminal"}]',
			JSON.stringify({
				"/tmp/proj": [
					null,
					[],
					{ kind: "", label: "Bad", side: "right" },
					{ kind: 1, label: "Bad", side: "right" },
					{ kind: "terminal", label: 1, side: "right" },
					{ kind: "terminal", label: "Bad", side: "left" },
				],
				"/tmp/bad": { kind: "terminal" },
			}),
		]) {
			localStorage.setItem(STORAGE_KEY, raw);
			expect(Object.values(hydrateProjectDockTabs()).flat()).toEqual([]);
			expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
		}
	});

	test("recovers valid legacy rows alongside malformed rows", () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				"/tmp/proj": [
					null,
					{ kind: "terminal", label: "Recovered", side: "right" },
					{ kind: "files", label: "Bad", side: false },
				],
			})
		);
		const restored = hydrateProjectDockTabs();
		expect(restored["/tmp/proj"]).toHaveLength(1);
		expect(restored["/tmp/proj"]?.[0]?.label).toBe("Recovered");
		expect(hydrateProjectDockTabs()).toEqual(restored);
	});

	test("new tabs cannot reuse another project's UI identity", () => {
		const addTab = useProjectDockStore.getState().addTab;
		const template = {
			uid: "requested",
			kind: "terminal" as const,
			label: "Terminal",
			side: "bottom" as const,
			pinned: true,
			ownerTabId: "chat-a",
		};
		const first = addTab("/tmp/a", template);
		const second = addTab("/tmp/b", template);
		const blank = addTab("/tmp/c", { ...template, uid: "" });
		expect(first.uid).toBe("requested");
		expect(new Set([first.uid, second.uid, blank.uid]).size).toBe(3);
		expect(hydrateProjectDockTabs()).toEqual({
			"/tmp/a": [{ ...first, ownerTabId: "" }],
			"/tmp/b": [{ ...second, ownerTabId: "" }],
			"/tmp/c": [{ ...blank, ownerTabId: "" }],
		});
	});

	test("unpinned UI identities never survive reload", () => {
		const tab = useProjectDockStore.getState().addTab("/tmp/proj", {
			kind: "terminal",
			label: "Terminal",
			side: "bottom",
			pinned: false,
			ownerTabId: "chat-a",
		});
		expect(localStorage.getItem(STORAGE_KEY)).toBe("{}");
		useProjectDockStore.getState().togglePin("/tmp/proj", tab.uid);
		expect(hydrateProjectDockTabs()["/tmp/proj"]?.[0]?.uid).toBe(tab.uid);
		useProjectDockStore.getState().togglePin("/tmp/proj", tab.uid);
		expect(hydrateProjectDockTabs()).toEqual({});
	});

	test("unpinning a restored shared tab gives it a current chat owner", () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				"/tmp/proj": [
					{
						uid: "saved-pin",
						kind: "terminal",
						label: "Terminal",
						side: "right",
					},
				],
			})
		);
		useProjectDockStore.setState({ byFolder: hydrateProjectDockTabs() });
		useProjectDockStore
			.getState()
			.togglePin("/tmp/proj", "saved-pin", "current-chat");
		expect(
			useProjectDockStore.getState().byFolder["/tmp/proj"]?.[0]
		).toMatchObject({
			uid: "saved-pin",
			pinned: false,
			ownerTabId: "current-chat",
		});
		useProjectDockStore.getState().clearOwner("/tmp/proj", "current-chat");
		expect(
			useProjectDockStore.getState().byFolder["/tmp/proj"]
		).toBeUndefined();
	});

	test("retired pinned kinds retain identity and serialize through the canonical unavailable renderer", () => {
		const folder = "/tmp/future";
		for (const kind of [
			"future-panel",
			"constructor",
			"__proto__",
			" future-panel ",
		]) {
			const saved = { uid: "future-pin", kind, label: "Future", side: "right" };
			localStorage.setItem(STORAGE_KEY, JSON.stringify({ [folder]: [saved] }));
			const byFolder = hydrateProjectDockTabs();
			const tab = byFolder[folder]?.[0];
			expect(tab).toMatchObject({ ...saved, pinned: true, ownerTabId: "" });
			if (!tab) {
				throw new Error("Expected restored pinned tab");
			}
			const renderer = {
				...restoreDockTabKind(tab.kind),
				uid: tab.uid,
				label: tab.label,
				pinned: tab.pinned,
				projectHosted: true,
			};
			expect(renderer.kind).toBe("unavailable");
			expect(renderer.persistedKind).toBe(kind);
			expect(serializeRestoredDockTab(renderer)).toEqual({
				kind,
				uid: saved.uid,
				label: saved.label,
				project: true,
				pinned: true,
			});
			useProjectDockStore.setState({ byFolder });
			useProjectDockStore.getState().setLabel(folder, saved.uid, "Renamed");
			expect(hydrateProjectDockTabs()[folder]?.[0]).toMatchObject({
				...saved,
				label: "Renamed",
				pinned: true,
				ownerTabId: "",
			});
		}
	});

	test("unavailable persistence leaves recoverable legacy pins usable", () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				"/tmp/proj": [{ kind: "terminal", label: "Terminal", side: "right" }],
			})
		);
		Object.defineProperty(localStorage, "setItem", {
			value: () => {
				throw new Error("Storage unavailable");
			},
		});
		expect(hydrateProjectDockTabs()["/tmp/proj"]?.[0]).toMatchObject({
			kind: "terminal",
			label: "Terminal",
			side: "right",
			pinned: true,
			ownerTabId: "",
		});
	});
});
