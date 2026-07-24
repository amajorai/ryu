import { describe, expect, it } from "bun:test";
import type {
	ComposerSettingItem,
	ComposerSettingsSection,
} from "./composer-settings-menu.tsx";
import {
	type ComposerShortcutEvent,
	handleComposerSettingsShortcut,
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

function keyEvent(partial: Partial<ComposerShortcutEvent> & { key: string }): {
	event: ComposerShortcutEvent;
	prevented: () => boolean;
} {
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

describe("handleComposerSettingsShortcut - guards", () => {
	const sections = [{ key: "agent", items: items("a1", "a2"), value: "a1" }];

	it.each([
		["altKey", { altKey: true }],
		["ctrlKey", { ctrlKey: true }],
		["metaKey", { metaKey: true }],
	])("ignores Tab when %s is held", (_name, mods) => {
		const changes: Changes = [];
		const secs = sections.map((s) => makeSection(s, changes));
		const { event } = keyEvent({ key: "Tab", ...mods });
		expect(handleComposerSettingsShortcut(event, secs)).toBe(false);
		expect(changes).toEqual([]);
	});

	it("ignores Tab while IME composition is active", () => {
		const changes: Changes = [];
		const secs = sections.map((s) => makeSection(s, changes));
		const { event } = keyEvent({
			key: "Tab",
			nativeEvent: { isComposing: true },
		});
		expect(handleComposerSettingsShortcut(event, secs)).toBe(false);
		expect(changes).toEqual([]);
	});

	it("returns false for an unrelated key", () => {
		const changes: Changes = [];
		const secs = sections.map((s) => makeSection(s, changes));
		const { event } = keyEvent({ key: "j" });
		expect(handleComposerSettingsShortcut(event, secs)).toBe(false);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(true);
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
		handleComposerSettingsShortcut(event, secs);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(true);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(false);
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
		handleComposerSettingsShortcut(event, secs);
		expect(changes).toEqual(["a1"]);
	});

	it("accepts an upper-case Tab key spelling", () => {
		const changes: Changes = [];
		const secs = [
			makeSection(
				{ key: "agent", items: items("a1", "a2"), value: "a1" },
				changes
			),
		];
		const { event } = keyEvent({ key: "TAB" });
		expect(handleComposerSettingsShortcut(event, secs)).toBe(true);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(true);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(true);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(false);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(true);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(false);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(true);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(true);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(false);
		expect(changes).toEqual([]);
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
		expect(handleComposerSettingsShortcut(event, secs)).toBe(true);
		expect(changes).toEqual(["a2"]);
	});

	it("cycles from the first item when the section has no value set", () => {
		const changes: Changes = [];
		const secs = [
			makeSection({ key: "agent", items: items("a1", "a2", "a3") }, changes),
		];
		const { event } = keyEvent({ key: "Tab" });
		handleComposerSettingsShortcut(event, secs);
		expect(changes).toEqual(["a2"]);
	});
});
