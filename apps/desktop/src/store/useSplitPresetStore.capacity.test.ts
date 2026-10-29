import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	MAX_NAME_LENGTH,
	MAX_PRESETS,
	makePresetBranch,
	makeSlot,
	type SplitPreset,
} from "../lib/splitPresets.ts";
import {
	SPLIT_PRESETS_KEY,
	useSplitPresetStore,
} from "./useSplitPresetStore.ts";

const registeredHere = !GlobalRegistrator.isRegistered;
if (registeredHere) {
	GlobalRegistrator.register();
}
const initialShape = makePresetBranch("columns", [
	makeSlot("/chat"),
	makeSlot("/files"),
]);
const changedShape = makePresetBranch(
	"rows",
	[makeSlot("/chat"), makeSlot("/settings")],
	[0.25, 0.75]
);
let seed: SplitPreset[] = [];

beforeEach(() => {
	localStorage.clear();
	seed = Array.from({ length: MAX_PRESETS }, (_, index) => ({
		id: `saved-${index}`,
		name: `Review ${index}`,
		root: initialShape,
		createdAt: index + 1,
	}));
	localStorage.setItem(SPLIT_PRESETS_KEY, JSON.stringify(seed));
	useSplitPresetStore.getState().reload();
	const loaded = useSplitPresetStore.getState().presets.length;
	if (loaded !== MAX_PRESETS) {
		throw new Error(
			`Capacity fixture loaded ${loaded} presets, expected ${MAX_PRESETS}`
		);
	}
});
afterAll(async () => {
	localStorage.clear();
	useSplitPresetStore.getState().reload();
	if (registeredHere) {
		await GlobalRegistrator.unregister();
	}
});

describe("saved pane layout capacity", () => {
	it("replaces an existing case-insensitive name at capacity and reloads its changed shape", () => {
		const replacement = useSplitPresetStore
			.getState()
			.savePreset("  REVIEW 29  ", changedShape);
		expect(replacement).not.toBeNull();
		if (!replacement) {
			throw new Error("Capacity replacement was refused");
		}
		expect(replacement.name).toBe("REVIEW 29");
		const unrelated = seed.filter((preset) => preset.name !== "Review 29");
		const persisted: SplitPreset[] = JSON.parse(
			localStorage.getItem(SPLIT_PRESETS_KEY) ?? "null"
		);
		expect(persisted).toHaveLength(MAX_PRESETS);
		expect(
			persisted.filter((preset) => preset.name.toLowerCase() === "review 29")
		).toEqual([replacement]);
		expect(
			persisted.filter((preset) => preset.name.toLowerCase() !== "review 29")
		).toEqual(unrelated);
		expect(replacement.root).toEqual(changedShape);
		useSplitPresetStore.getState().reload();
		expect(useSplitPresetStore.getState().presets).toEqual(persisted);
	});
	it("refuses a new sixty-first name without changing durable or visible layouts", () => {
		const before = localStorage.getItem(SPLIT_PRESETS_KEY);
		expect(
			useSplitPresetStore.getState().savePreset("New layout", changedShape)
		).toBeNull();
		expect(localStorage.getItem(SPLIT_PRESETS_KEY)).toBe(before);
		expect(useSplitPresetStore.getState().presets).toEqual(seed);
		useSplitPresetStore.getState().reload();
		expect(useSplitPresetStore.getState().presets).toEqual(seed);
	});
});
describe("saved pane layout bounded names", () => {
	beforeEach(() => {
		localStorage.clear();
		useSplitPresetStore.getState().reload();
	});
	it("saves a long name consistently in visible state, storage and reloaded state", () => {
		const unrelated = useSplitPresetStore
			.getState()
			.savePreset("Other layout", initialShape);
		const name = "L".repeat(MAX_NAME_LENGTH);
		const saved = useSplitPresetStore
			.getState()
			.savePreset(`  ${name}-extra  `, changedShape);
		expect(saved).not.toBeNull();
		if (!(saved && unrelated)) {
			throw new Error("Real fixture preset creation failed");
		}
		const visible = useSplitPresetStore.getState().presets;
		const stored: SplitPreset[] = JSON.parse(
			localStorage.getItem(SPLIT_PRESETS_KEY) ?? "null"
		);
		useSplitPresetStore.getState().reload();
		const reloaded = useSplitPresetStore.getState().presets;
		expect({
			saved: saved.name,
			visible: visible.find((preset) => preset.id === saved.id)?.name,
			stored: stored.find((preset) => preset.id === saved.id)?.name,
			reloaded: reloaded.find((preset) => preset.id === saved.id)?.name,
		}).toEqual({ saved: name, visible: name, stored: name, reloaded: name });
		expect(reloaded).toHaveLength(2);
		expect(reloaded.find((preset) => preset.id === saved.id)?.root).toEqual(
			changedShape
		);
		expect(reloaded.find((preset) => preset.id === unrelated.id)).toEqual(
			unrelated
		);
	});
	it("renames a long name consistently without changing its shape or unrelated layouts", () => {
		const renamed = useSplitPresetStore
			.getState()
			.savePreset("Original name", changedShape);
		const unrelated = useSplitPresetStore
			.getState()
			.savePreset("Other layout", initialShape);
		if (!(renamed && unrelated)) {
			throw new Error("Real fixture preset creation failed");
		}
		const name = "R".repeat(MAX_NAME_LENGTH);
		useSplitPresetStore
			.getState()
			.renamePreset(renamed.id, `  ${name}-extra  `);
		const visible = useSplitPresetStore.getState().presets;
		const stored: SplitPreset[] = JSON.parse(
			localStorage.getItem(SPLIT_PRESETS_KEY) ?? "null"
		);
		useSplitPresetStore.getState().reload();
		const reloaded = useSplitPresetStore.getState().presets;
		expect({
			visible: visible.find((preset) => preset.id === renamed.id)?.name,
			stored: stored.find((preset) => preset.id === renamed.id)?.name,
			reloaded: reloaded.find((preset) => preset.id === renamed.id)?.name,
		}).toEqual({ visible: name, stored: name, reloaded: name });
		expect(reloaded.find((preset) => preset.id === renamed.id)).toEqual({
			...renamed,
			name,
		});
		expect(reloaded.find((preset) => preset.id === unrelated.id)).toEqual(
			unrelated
		);
	});
});
