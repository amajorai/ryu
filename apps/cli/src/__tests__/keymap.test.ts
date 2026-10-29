import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMMAND_REGISTRY } from "../core/commands.ts";
import {
	ALL_KEYMAP,
	CHAT_KEYMAP,
	filterKeymap,
	GLOBAL_KEYMAP,
	globalHints,
	isHelpKey,
	type KeyChord,
	keymapForMode,
	keymapGroups,
	matchGlobalBinding,
	paletteShortcut,
} from "../core/keymap.ts";

function chord(partial: Partial<KeyChord> & { name: string }): KeyChord {
	return {
		ctrl: false,
		meta: false,
		option: false,
		sequence: partial.name.length === 1 ? partial.name : "",
		shift: false,
		...partial,
	};
}

test("groups keymap entries in display order", () => {
	const groups = keymapGroups();

	expect(groups.map(({ group }) => group)).toEqual([
		"Navigation",
		"Chat",
		"Commands",
	]);
	expect(groups[0]?.entries[0]).toMatchObject({
		group: "Navigation",
		id: "palette",
		keys: "Ctrl+K",
		label: "open command palette",
		scope: "global",
	});
});

test("every keymap id is unique", () => {
	const ids = ALL_KEYMAP.map((entry) => entry.id);
	expect(new Set(ids).size).toBe(ids.length);
});

test("keymap documents every chat-owned modified shortcut", () => {
	const shortcuts = new Set(ALL_KEYMAP.map((entry) => entry.keys));

	for (const shortcut of [
		"Ctrl+A",
		"Ctrl+R",
		"Ctrl+L",
		"Ctrl+C",
		"Ctrl+Q",
		"Ctrl+O",
		"Ctrl+C ×2",
	]) {
		expect(shortcuts.has(shortcut)).toBe(true);
	}
	expect(CHAT_KEYMAP.every((entry) => entry.scope === "chat")).toBe(true);
	// Ctrl+? stays a displayed alias of the shortcuts overlay.
	expect(GLOBAL_KEYMAP.find((entry) => entry.id === "keymap")?.keys).toContain(
		"Ctrl+?"
	);
});

test("the Commands group lists every built-in slash command", () => {
	const commandKeys = ALL_KEYMAP.filter(
		(entry) => entry.group === "Commands"
	).map((entry) => entry.keys);
	expect(commandKeys).toEqual(COMMAND_REGISTRY.map((spec) => `/${spec.name}`));
});

// The census: every binding App.tsx's shell dispatches, as the key events a
// terminal delivers, resolves to a GLOBAL_KEYMAP entry.
const GLOBAL_KEY_CENSUS: [KeyChord, string][] = [
	[chord({ ctrl: true, name: "k" }), "palette"],
	[chord({ ctrl: true, name: "n" }), "node"],
	[chord({ ctrl: true, name: "t" }), "new-tab"],
	[chord({ ctrl: true, name: "t", shift: true }), "restore-tab"],
	[chord({ ctrl: true, name: "w" }), "close-tab"],
	[chord({ ctrl: true, name: "s", option: true }), "split"],
	[chord({ ctrl: true, name: "tab" }), "cycle-tab"],
	[chord({ ctrl: true, name: "tab", shift: true }), "cycle-tab"],
	[chord({ ctrl: true, name: "m", shift: true }), "mode"],
	[chord({ ctrl: true, name: "b" }), "sidebar"],
	[chord({ name: "b", option: true }), "sidebar"],
	[chord({ name: "b", meta: true }), "sidebar"],
	[chord({ name: "f6", sequence: "\u001b[17~" }), "sidebar-focus"],
	[chord({ name: "0", option: true }), "sidebar-focus"],
	[chord({ name: "0", meta: true }), "sidebar-focus"],
	[chord({ name: "left", option: true }), "focus-pane"],
	[chord({ name: "right", option: true }), "focus-pane"],
	[chord({ name: "up", option: true }), "focus-pane"],
	[chord({ name: "down", option: true }), "focus-pane"],
	[chord({ ctrl: true, name: "right", shift: true }), "move-tab"],
	[chord({ ctrl: true, name: "down", shift: true }), "move-tab"],
	[chord({ ctrl: true, name: "up", shift: true }), "move-tab"],
	[chord({ name: "1", option: true }), "focus-tab"],
	[chord({ name: "9", meta: true }), "focus-tab"],
	[chord({ name: "f1", sequence: "\u001bOP" }), "keymap"],
	[chord({ ctrl: true, name: "?" }), "keymap"],
	[chord({ ctrl: true, name: "/" }), "keymap"],
	[chord({ ctrl: true, name: "_", sequence: "\u001f" }), "keymap"],
	[chord({ ctrl: true, name: "c" }), "quit"],
];

test("every shell-handled global key matches its keymap entry", () => {
	for (const [key, id] of GLOBAL_KEY_CENSUS) {
		const entry = GLOBAL_KEYMAP.find((candidate) => candidate.match?.(key));
		expect({ id: entry?.id, key }).toEqual({ id, key });
		expect(matchGlobalBinding(key)).toBe(id);
	}
	const covered = new Set(GLOBAL_KEY_CENSUS.map(([, id]) => id));
	for (const entry of GLOBAL_KEYMAP) {
		expect(covered.has(entry.id)).toBe(true);
	}
});

test("App.tsx dispatches every global keymap id it does not special-case", () => {
	const source = readFileSync(resolve(import.meta.dir, "../App.tsx"), "utf8");
	const block = source.match(
		/const workspaceActions[\s\S]*?= \{\n([\s\S]*?)\n\t\};/
	)?.[1];
	expect(block).toBeDefined();
	const handled = [...(block ?? "").matchAll(/^\t\t"?([\w-]+)"?:/gm)].map(
		(match) => match[1]
	);
	// Ctrl+C is layered before dispatch (copy / interrupt / two-press quit).
	const dispatched = GLOBAL_KEYMAP.filter((entry) => entry.id !== "quit").map(
		(entry) => entry.id
	);
	expect(handled.sort()).toEqual(dispatched.sort());
});

test("unmodified and plain typing keys are not global bindings", () => {
	expect(matchGlobalBinding(chord({ name: "k" }))).toBeNull();
	expect(matchGlobalBinding(chord({ name: "t", shift: true }))).toBeNull();
	expect(matchGlobalBinding(chord({ name: "left" }))).toBeNull();
	// Ctrl+Shift+Left has no region to move to (the sidebar holds that edge).
	expect(
		matchGlobalBinding(chord({ ctrl: true, name: "left", shift: true }))
	).toBeNull();
	// Typing "b" or "0" into a composer never toggles or focuses the sidebar.
	expect(matchGlobalBinding(chord({ name: "b" }))).toBeNull();
	expect(matchGlobalBinding(chord({ name: "0" }))).toBeNull();
	// Typing a digit never jumps tabs; only Alt+1..9 does.
	expect(matchGlobalBinding(chord({ name: "2" }))).toBeNull();
});

test("a bare ? opens the shortcuts only while no text field owns input", () => {
	const question = chord({ name: "?" });
	expect(isHelpKey(question)).toBe(true);
	expect(isHelpKey(question, { inputFocused: true })).toBe(false);
	expect(matchGlobalBinding(question, { inputFocused: false })).toBe("keymap");
	expect(matchGlobalBinding(question, { inputFocused: true })).toBeNull();
	// F1 and Ctrl+? work even while typing.
	expect(isHelpKey(chord({ name: "f1" }), { inputFocused: true })).toBe(true);
	expect(
		isHelpKey(chord({ ctrl: true, name: "_" }), { inputFocused: true })
	).toBe(true);
	expect(isHelpKey(chord({ meta: true, name: "?" }))).toBe(false);
});

test("filterKeymap matches keys, labels and groups case-insensitively", () => {
	const split = filterKeymap(ALL_KEYMAP, "SPLIT");
	expect(split.map((entry) => entry.id)).toEqual(["split"]);
	expect(
		filterKeymap(ALL_KEYMAP, "ctrl+alt+s").map((entry) => entry.id)
	).toEqual(["split"]);
	expect(filterKeymap(ALL_KEYMAP, "commands")).toHaveLength(
		COMMAND_REGISTRY.length
	);
	expect(filterKeymap(ALL_KEYMAP, "  ")).toHaveLength(ALL_KEYMAP.length);
	expect(filterKeymap(ALL_KEYMAP, "no such shortcut")).toEqual([]);
});

test("Bot mode hides routing shortcuts and commands", () => {
	const bot = keymapForMode("bot").map((entry) => entry.keys);
	for (const hidden of [
		"Ctrl+A",
		"Ctrl+N",
		"Ctrl+R",
		"/agent",
		"/group",
		"/model",
	]) {
		expect(bot).not.toContain(hidden);
	}
	expect(bot).toContain("/check");
	expect(keymapForMode("console").map((entry) => entry.keys)).toContain(
		"Ctrl+A"
	);
});

test("status-bar hints and palette shortcuts come from the registry", () => {
	expect(globalHints("console")).toEqual([
		{ keys: "^K", label: "palette", priority: 0 },
		{ keys: "^N", label: "node", priority: 4 },
		{ keys: "^T", label: "new", priority: 2 },
		{ keys: "^W", label: "close", priority: 3 },
		{ keys: "^B", label: "sidebar", priority: 6 },
		{ keys: "^⇧M", label: "mode", priority: 5 },
		{ keys: "F1", label: "keys", priority: 1.2 },
		{ keys: "^C×2", label: "quit", priority: 1 },
	]);
	expect(globalHints("bot").map((hint) => hint.keys)).not.toContain("^N");
	expect(paletteShortcut("action:new-chat")).toBe("Ctrl+T");
	expect(paletteShortcut("action:keymap")).toContain("F1");
	expect(paletteShortcut("nav:/chat")).toBeUndefined();
	expect(paletteShortcut("action:sidebar")).toBe("Ctrl+B / Alt+B");
});

test("keymap documents transcript scrolling shortcuts", () => {
	const shortcuts = new Set(CHAT_KEYMAP.map((entry) => entry.keys));

	expect(shortcuts.has("PgUp / PgDn")).toBe(true);
	expect(shortcuts.has("Ctrl+Home / Ctrl+End")).toBe(true);
});

test("keymap documents the composer newline shortcuts", () => {
	const newline = CHAT_KEYMAP.find(
		(entry) => entry.label === "insert a newline"
	);

	expect(newline?.keys).toBe("Shift+Enter / Alt+Enter / Ctrl+J");
});
