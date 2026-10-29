import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { makePresetBranch, makeSlot } from "../lib/splitPresets.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const { SPLIT_PRESETS_KEY, useSplitPresetStore } = await import(
	"./useSplitPresetStore.ts"
);
const shape = makePresetBranch("columns", [
	makeSlot("/chat"),
	makeSlot("/files"),
]);

let restoreWrite: (() => void) | undefined;
beforeEach(() => {
	localStorage.clear();
	useSplitPresetStore.getState().reload();
});
afterEach(() => {
	restoreWrite?.();
	restoreWrite = undefined;
});
function refuse() {
	const original = localStorage.setItem;
	Object.defineProperty(localStorage, "setItem", {
		configurable: true,
		value: () => {
			throw new DOMException("Storage quota reached", "QuotaExceededError");
		},
	});
	restoreWrite = () =>
		Object.defineProperty(localStorage, "setItem", {
			configurable: true,
			value: original,
		});
}
for (const operation of ["save", "rename", "delete"] as const) {
	test(`${operation} rejects failed persistence without publishing success and can retry`, () => {
		const first = useSplitPresetStore.getState().savePreset("Research", shape);
		const unrelated = useSplitPresetStore.getState().savePreset("Other", shape);
		if (!(first && unrelated)) {
			throw new Error("Fixture creation failed");
		}
		const before = localStorage.getItem(SPLIT_PRESETS_KEY);
		const state = useSplitPresetStore.getState().presets;
		const mutate = () => {
			const store = useSplitPresetStore.getState();
			if (operation === "save") {
				return store.savePreset("New", shape);
			}
			if (operation === "rename") {
				return store.renamePreset(first.id, "Renamed");
			}
			return store.deletePreset(first.id);
		};
		refuse();
		expect(mutate).toThrow("Storage quota reached");
		expect(useSplitPresetStore.getState().presets).toEqual(state);
		expect(localStorage.getItem(SPLIT_PRESETS_KEY)).toBe(before);
		restoreWrite?.();
		restoreWrite = undefined;
		mutate();
		const changed = useSplitPresetStore.getState().presets;
		expect(changed.find((preset) => preset.id === unrelated.id)).toEqual(
			unrelated
		);
		if (operation === "save") {
			expect(changed.map((preset) => preset.name)).toEqual([
				"Research",
				"Other",
				"New",
			]);
		}
		if (operation === "rename") {
			expect(changed.find((preset) => preset.id === first.id)).toEqual({
				...first,
				name: "Renamed",
			});
		}
		if (operation === "delete") {
			expect(changed).toEqual([unrelated]);
		}
		useSplitPresetStore.getState().reload();
		expect(useSplitPresetStore.getState().presets).toEqual(changed);
	});
}
test("deleting the final layout rejects removeItem refusal and preserves it after reload", () => {
	const saved = useSplitPresetStore.getState().savePreset("Only", shape);
	if (!saved) {
		throw new Error("Fixture creation failed");
	}
	const original = localStorage.removeItem;
	Object.defineProperty(localStorage, "removeItem", {
		configurable: true,
		value: () => {
			throw new DOMException("Storage unavailable", "SecurityError");
		},
	});
	try {
		expect(() => useSplitPresetStore.getState().deletePreset(saved.id)).toThrow(
			"Storage unavailable"
		);
		expect(useSplitPresetStore.getState().presets).toEqual([saved]);
		useSplitPresetStore.getState().reload();
		expect(useSplitPresetStore.getState().presets).toEqual([saved]);
	} finally {
		Object.defineProperty(localStorage, "removeItem", {
			configurable: true,
			value: original,
		});
	}
	useSplitPresetStore.getState().deletePreset(saved.id);
	expect(localStorage.getItem(SPLIT_PRESETS_KEY)).toBeNull();
	useSplitPresetStore.getState().reload();
	expect(useSplitPresetStore.getState().presets).toEqual([]);
});
