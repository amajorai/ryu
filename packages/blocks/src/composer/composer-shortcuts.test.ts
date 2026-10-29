import { describe, expect, it } from "bun:test";
import type {
	ComposerSettingItem,
	ComposerSettingsSection,
} from "./composer-settings-menu.tsx";
import {
	type ComposerShortcutBindings,
	type ComposerShortcutEvent,
	handleComposerSettingsShortcut,
	resolveComposerShortcutBindings,
} from "./composer-shortcuts.ts";

type Changes = string[];

function makeSection(
	partial: Partial<ComposerSettingsSection> & {
		key: string;
		items: ComposerSettingItem[];
	},
	changes: Changes
): ComposerSettingsSection {
	return {
		ariaLabel: partial.label ?? partial.key,
		label: partial.label ?? partial.key,
		value: partial.value,
		onChange: (id: string) => changes.push(id),
		...partial,
	};
}

function items(...ids: string[]): ComposerSettingItem[] {
	return ids.map((id) => ({ id, name: id }));
}

function keyEvent(partial: Partial<ComposerShortcutEvent> & { key: string }) {
	let didPrevent = false;
	const event: ComposerShortcutEvent = {
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		preventDefault: () => {
			didPrevent = true;
		},
		...partial,
	};
	return { event, prevented: () => didPrevent };
}

const defaults = resolveComposerShortcutBindings();

describe("handleComposerSettingsShortcut - guards", () => {
	const sections = [{ key: "agent", items: items("a1", "a2"), value: "a1" }];

	it.each([
		["altKey", { altKey: true }],
		["ctrlKey", { ctrlKey: true }],
		["metaKey", { metaKey: true }],
	])("ignores Tab when %s is held (defaults)", (_name, mods) => {
		const changes: Changes = [];
		const secs = sections.map((s) => makeSection(s, changes));
		const { event } = keyEvent({ key: "Tab", ...mods });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(false);
		expect(changes).toEqual([]);
	});

	it("ignores Tab while IME composition is active", () => {
		const changes: Changes = [];
		const secs = sections.map((s) => makeSection(s, changes));
		const { event } = keyEvent({
			key: "Tab",
			nativeEvent: { isComposing: true },
		});
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(false);
		expect(changes).toEqual([]);
	});

	it("returns false for an unrelated key", () => {
		const changes: Changes = [];
		const secs = sections.map((s) => makeSection(s, changes));
		const { event } = keyEvent({ key: "j" });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(false);
		expect(changes).toEqual([]);
	});
});

describe("Tab cycles the agent section", () => {
	it("advances to the next agent and prevents default", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "a2", "a3"), value: "a1" },
				changes
			),
		];
		const { event, prevented } = keyEvent({ key: "Tab" });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["a2"]);
		expect(prevented()).toBe(true);
	});

	it("wraps around from the last agent to the first", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "a2", "a3"), value: "a3" },
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab" });
		handleComposerSettingsShortcut(event, secs, defaults);
		expect(changes).toEqual(["a1"]);
	});

	it("skips the create-agent sentinel and team entries", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{
					key: "agent",
					items: items("a1", "__create_agent__", "team:x", "a2"),
					value: "a1",
				},
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab" });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["a2"]);
	});

	it("does nothing when only one cyclable agent remains", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "__create_agent__"), value: "a1" },
				changes
			),
		];
		const { event, prevented } = keyEvent({ key: "Tab" });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(false);
		expect(changes).toEqual([]);
		expect(prevented()).toBe(false);
	});

	it("starts from the first item when the current value was filtered out", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "team:x", "a2"), value: "team:x" },
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab" });
		handleComposerSettingsShortcut(event, secs, defaults);
		expect(changes).toEqual(["a1"]);
	});

	it("matches the canonical Tab key from a KeyboardEvent", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "a2"), value: "a1" },
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab" });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["a2"]);
	});
});

describe("Shift+Tab cycles the approval section", () => {
	it("advances the section whose key is 'approval'", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "approval", items: items("plan", "auto"), value: "plan" },
				changes
			),
		];
		const { event, prevented } = keyEvent({ key: "Tab", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["auto"]);
		expect(prevented()).toBe(true);
	});

	it("also matches a section labelled 'Mode'", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "perm", label: "Mode", items: items("m1", "m2"), value: "m1" },
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["m2"]);
	});

	it("does not cycle the agent section on Shift+Tab", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "a2"), value: "a1" },
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(false);
		expect(changes).toEqual([]);
	});

	it("skips a bypassPermissions mode, which needs the menu's confirmation", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{
					key: "approval",
					items: items("default", "acceptEdits", "plan", "bypassPermissions"),
					value: "plan",
				},
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["default"]);
	});

	it("skips a 'Full access' config option value", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{
					key: "sandbox_preset",
					label: "Approval",
					items: [
						{ id: "read-only", name: "Read only" },
						{ id: "auto", name: "Auto" },
						{ id: "full", name: "Full access" },
					],
					value: "auto",
				},
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["read-only"]);
	});

	it("steps down to the first item when the current mode is full access", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{
					key: "approval",
					items: items("default", "plan", "bypassPermissions"),
					value: "bypassPermissions",
				},
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["default"]);
	});

	it("leaves full access for the only safe mode in a two-option section", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{
					key: "approval",
					items: items("default", "bypassPermissions"),
					value: "bypassPermissions",
				},
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["default"]);
	});

	it("does not move into full access from the only safe mode", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{
					key: "approval",
					items: items("default", "bypassPermissions"),
					value: "default",
				},
				changes
			),
		];
		const { event } = keyEvent({ key: "Tab", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(false);
		expect(changes).toEqual([]);
	});
});

describe("Shift+M cycles the model section", () => {
	it("advances the model section", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "model", items: items("gpt", "claude"), value: "gpt" },
				changes
			),
		];
		const { event } = keyEvent({ key: "m", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["claude"]);
	});

	it("requires Shift (plain 'm' is ignored)", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "model", items: items("gpt", "claude"), value: "gpt" },
				changes
			),
		];
		const { event } = keyEvent({ key: "m" });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(false);
		expect(changes).toEqual([]);
	});
});

describe("Shift+T cycles the thinking section", () => {
	it("advances a section recognized as thinking by its label", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{
					key: "reasoning",
					label: "Reasoning effort",
					items: items("low", "high"),
					value: "low",
				},
				changes
			),
		];
		const { event } = keyEvent({ key: "t", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["high"]);
	});

	it("falls back to the first extra-config section when no thinking section exists", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "a2"), value: "a1" },
				changes
			),
			makeSection(
				{ key: "model", items: items("g", "c"), value: "g" },
				changes
			),
			makeSection(
				{
					key: "verbosity",
					label: "Verbosity",
					items: items("terse", "chatty"),
					value: "terse",
				},
				changes
			),
		];
		const { event } = keyEvent({ key: "t", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["chatty"]);
	});

	it("does not fall back onto agent, model, or approval sections", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "a2"), value: "a1" },
				changes
			),
			makeSection(
				{ key: "model", items: items("g", "c"), value: "g" },
				changes
			),
			makeSection(
				{ key: "approval", items: items("plan", "auto"), value: "plan" },
				changes
			),
		];
		const { event } = keyEvent({ key: "t", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(false);
		expect(changes).toEqual([]);
	});
});

describe("custom bindings", () => {
	it("honors a rebound cycle-agent chord", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "a2"), value: "a1" },
				changes
			),
		];
		const bindings: ComposerShortcutBindings = {
			...defaults,
			"composer.cycle-agent": "Shift+A",
		};
		const { event, prevented } = keyEvent({ key: "a", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, bindings)).toBe(true);
		expect(changes).toEqual(["a2"]);
		expect(prevented()).toBe(true);
		const { event: tab } = keyEvent({ key: "Tab" });
		expect(handleComposerSettingsShortcut(tab, secs, bindings)).toBe(false);
	});

	it("skips an unbound action", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "model", items: items("gpt", "claude"), value: "gpt" },
				changes
			),
		];
		const bindings: ComposerShortcutBindings = {
			...defaults,
			"composer.cycle-model": null,
		};
		const { event } = keyEvent({ key: "m", shiftKey: true });
		expect(handleComposerSettingsShortcut(event, secs, bindings)).toBe(false);
		expect(changes).toEqual([]);
	});

	it("supports a Mod-bearing custom binding", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "model", items: items("gpt", "claude"), value: "gpt" },
				changes
			),
		];
		const bindings: ComposerShortcutBindings = {
			...defaults,
			"composer.cycle-model": "Mod+Shift+M",
		};
		const { event, prevented } = keyEvent({
			key: "m",
			shiftKey: true,
			metaKey: true,
		});
		expect(handleComposerSettingsShortcut(event, secs, bindings)).toBe(true);
		expect(changes).toEqual(["claude"]);
		expect(prevented()).toBe(true);
	});
});

describe("edge behavior", () => {
	it("does not throw when preventDefault is absent", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "a2"), value: "a1" },
				changes
			),
		];
		const event: ComposerShortcutEvent = {
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			key: "Tab",
		};
		expect(handleComposerSettingsShortcut(event, secs, defaults)).toBe(true);
		expect(changes).toEqual(["a2"]);
	});

	it("cycles from the first item when the section has no value set", () => {
		const changes: Changes = [];
		const secs = [
			makeSection({ key: "agent", items: items("a1", "a2", "a3") }, changes),
		];
		const { event } = keyEvent({ key: "Tab" });
		handleComposerSettingsShortcut(event, secs, defaults);
		expect(changes).toEqual(["a2"]);
	});
});
