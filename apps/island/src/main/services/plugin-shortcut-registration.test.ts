import { expect, test } from "bun:test";
import { toElectronAccelerator } from "../../../../../packages/hotkeys/src/chord.ts";
import type {
	PluginCompanion,
	PluginContributionsResult,
} from "../../shared/ipc.ts";
import { createPluginShortcutRegistrar } from "./plugin-shortcut-registration.ts";

function companion(id: string, shortcut: string | null): PluginCompanion {
	return {
		id,
		pluginId: id,
		shortcut,
		approvedGrants: [],
		defaultCspEnforced: true,
		hasUi: true,
		icon: null,
		label: id,
		name: id,
	};
}
function snapshot(...companions: PluginCompanion[]): PluginContributionsResult {
	return { available: true, companions, views: [] };
}
function boundary() {
	const active = new Map<string, () => void>();
	const registered: string[] = [];
	const removed: string[] = [];
	const opened: string[] = [];
	let focusCount = 0;
	const refused = new Set<string>();
	const throwing = new Set<string>();
	const reconcile = createPluginShortcutRegistrar({
		register(accelerator, handler) {
			registered.push(accelerator);
			if (throwing.has(accelerator)) {
				throw new Error("OS accelerator unavailable");
			}
			if (refused.has(accelerator)) {
				return false;
			}
			active.set(accelerator, handler);
			return true;
		},
		unregister(accelerator) {
			removed.push(accelerator);
			active.delete(accelerator);
		},
		focus() {
			focusCount += 1;
		},
		sendShortcut(id) {
			opened.push(id);
		},
	});
	return {
		active,
		registered,
		removed,
		opened,
		refused,
		throwing,
		reconcile,
		focusCount: () => focusCount,
	};
}

test("the exact accelerator emitted by Desktop settings registers and activates its companion", () => {
	const os = boundary();
	const stored = toElectronAccelerator("Mod+Shift+K");
	expect(stored).toBe("CommandOrControl+Shift+K");
	os.reconcile(
		snapshot(companion("alpha", "Mod+Shift+A")),
		{ "plugin:alpha": stored },
		[]
	);
	expect([...os.active.keys()]).toEqual([stored]);
	os.active.get(stored)?.();
	expect(os.opened).toEqual(["alpha"]);
	expect(os.focusCount()).toBe(1);
});

test("clear, reset and disabled snapshots release registered actions without disturbing reserved chords", () => {
	const os = boundary();
	const enabled = snapshot(
		companion("alpha", "Mod+A"),
		companion("beta", "Mod+B")
	);
	os.reconcile(enabled, {}, ["CommandOrControl+B"]);
	expect([...os.active.keys()]).toEqual(["CommandOrControl+A"]);
	os.active.get("CommandOrControl+A")?.();
	os.reconcile(enabled, { "plugin:alpha": null }, ["CommandOrControl+B"]);
	expect(os.active.size).toBe(0);
	expect(os.removed).toEqual(["CommandOrControl+A"]);
	expect(os.opened).toEqual(["alpha"]);
	expect(os.focusCount()).toBe(1);
	os.reconcile(enabled, {}, ["CommandOrControl+B"]);
	expect([...os.active.keys()]).toEqual(["CommandOrControl+A"]);
	os.reconcile(snapshot(), {}, ["CommandOrControl+B"]);
	expect(os.active.size).toBe(0);
	expect(os.removed).toEqual(["CommandOrControl+A", "CommandOrControl+A"]);
});

test("OS registration refusal and plugin conflicts recover on a fresh acknowledged snapshot", () => {
	const os = boundary();
	const enabled = snapshot(
		companion("alpha", "Mod+K"),
		companion("beta", "Mod+K")
	);
	os.refused.add("CommandOrControl+K");
	os.reconcile(enabled, {}, []);
	expect(os.active.size).toBe(0);
	expect(os.opened).toEqual([]);
	os.refused.clear();
	os.throwing.add("CommandOrControl+K");
	os.reconcile(enabled, {}, []);
	expect(os.active.size).toBe(0);
	expect(os.opened).toEqual([]);
	os.throwing.clear();
	os.reconcile(enabled, {}, []);
	expect([...os.active.keys()]).toEqual(["CommandOrControl+K"]);
	os.active.get("CommandOrControl+K")?.();
	expect(os.opened).toEqual(["alpha"]);
	expect(os.focusCount()).toBe(1);
	os.reconcile({ available: false, reason: "Core offline" }, {}, []);
	expect(os.active.size).toBe(0);
	expect(os.removed).toEqual(["CommandOrControl+K"]);
});

test("a Ctrl default or override registers the Control key, as Desktop's converter emits it, not Command-or-Control", () => {
	const os = boundary();
	expect(toElectronAccelerator("Ctrl+K")).toBe("Control+K");
	os.reconcile(
		snapshot(companion("alpha", "Ctrl+K"), companion("beta", "Mod+K")),
		{},
		[]
	);
	expect([...os.active.keys()].sort()).toEqual([
		"CommandOrControl+K",
		"Control+K",
	]);
	os.active.get("Control+K")?.();
	os.active.get("CommandOrControl+K")?.();
	expect(os.opened).toEqual(["alpha", "beta"]);
	os.reconcile(
		snapshot(companion("alpha", "Ctrl+K")),
		{ "plugin:alpha": toElectronAccelerator("Ctrl+Shift+J") },
		[]
	);
	expect([...os.active.keys()]).toEqual(["Control+Shift+J"]);
});

test("a manifest Shift-only chord is never claimed system-wide, but a user override is honoured", () => {
	const os = boundary();
	os.reconcile(
		snapshot(
			companion("alpha", "shift+a"),
			companion("beta", "Shift+Space"),
			companion("gamma", "alt+shift+g")
		),
		{},
		[]
	);
	expect(os.registered).toEqual(["Alt+Shift+G"]);
	os.reconcile(
		snapshot(companion("alpha", "shift+a")),
		{ "plugin:alpha": "Shift+A" },
		[]
	);
	expect([...os.active.keys()]).toEqual(["Shift+A"]);
});
