import { commandHelpRows } from "./commands.ts";
import type { ProductMode } from "./productMode.ts";

/** One key-hint segment, rendered as "keys label" (e.g. "↑↓ move"). Hints with a
 * lower `priority` are kept first when the status bar is too narrow; the default
 * is {@link DEFAULT_HINT_PRIORITY}. */
export interface KeyHint {
	keys: string;
	label: string;
	priority?: number;
}

export const DEFAULT_HINT_PRIORITY = 50;

/** Shared hint vocabulary so every surface spells the same action the same way
 * ("↑↓ move", "Enter open", "r refresh", "Esc cancel"). */
export const HINT = {
	back: { keys: "Esc", label: "back" },
	cancel: { keys: "Esc", label: "cancel" },
	choose: { keys: "Enter", label: "choose" },
	interrupt: { keys: "Esc", label: "interrupt" },
	move: { keys: "↑↓", label: "move" },
	open: { keys: "Enter", label: "open" },
	refresh: { keys: "r", label: "refresh" },
	retry: { keys: "r", label: "retry" },
	search: { keys: "/", label: "search" },
} as const satisfies Record<string, KeyHint>;

/** Join hints into an inline hint line: "↑↓ move · Enter open · r refresh". */
export function hintText(hints: readonly KeyHint[]): string {
	return hints.map((hint) => `${hint.keys} ${hint.label}`).join(" · ");
}

/** The key fields a binding matcher reads (a subset of OpenTUI's KeyEvent). */
export interface KeyChord {
	ctrl: boolean;
	meta: boolean;
	name: string;
	option: boolean;
	sequence: string;
	shift: boolean;
}

/** Where a binding is live: the shell ("global"), the chat surface, or another
 * surface id. */
export type KeymapScope = "global" | "chat" | (string & {});

/** One documented shortcut. The registry is the single source for the keymap
 * overlay, the status-bar hints and the palette's shortcut column. */
export interface KeymapEntry {
	group: string;
	/** Short status-bar form ("^K"); only entries with a hint show there. */
	hint?: string;
	/** Status-bar priority for {@link hint} (lower survives a narrow terminal). */
	hintPriority?: number;
	/** Stable id, unique across {@link ALL_KEYMAP}. */
	id: string;
	/** Display form shown in the keymap overlay ("Ctrl+Alt+S"). */
	keys: string;
	label: string;
	/** Matches the live key event for bindings the shell dispatches itself. */
	match?: (key: KeyChord) => boolean;
	/** Product modes the entry applies to; omitted means every mode. */
	modes?: readonly ProductMode[];
	/** Command-palette action id that runs the same thing, for its shortcut column. */
	paletteAction?: string;
	scope: KeymapScope;
}

const NON_BOT_MODES: readonly ProductMode[] = ["console", "os"];

/** Alt arrives as `option` (kitty / modifyOtherKeys) or as `meta` (an ESC
 * prefix), depending on the terminal. */
function isAlt(key: KeyChord): boolean {
	return !key.ctrl && (key.option || key.meta);
}

/** The arrow key names Alt+Arrow pane focus answers to. */
function isArrowKey(name: string): name is FocusArrow {
	return (
		name === "left" || name === "right" || name === "up" || name === "down"
	);
}

export type FocusArrow = "down" | "left" | "right" | "up";

/**
 * The region Ctrl+Shift+Arrow moves the focused tab to (Up returns it to
 * Center), or null. Left has no target: the sidebar holds the left edge.
 */
export function moveTargetFor(
	keyName: string
): "bottom" | "center" | "right" | null {
	switch (keyName) {
		case "down":
			return "bottom";
		case "right":
			return "right";
		case "up":
			return "center";
		default:
			return null;
	}
}

/** Legacy terminals send Ctrl+/ and Ctrl+? as 0x1F, which parses as Ctrl+_. */
function isCtrlHelpKey(key: KeyChord): boolean {
	return key.ctrl && (key.name === "?" || key.name === "/" || key.name === "_");
}

/**
 * True for the keymap-overlay key: F1 or Ctrl+? (any spelling) always; a bare
 * "?" only when no text field owns character input, so typing "?" into a
 * composer or filter never opens the overlay.
 */
export function isHelpKey(
	key: KeyChord,
	options: { inputFocused?: boolean } = {}
): boolean {
	if (key.name === "f1" || isCtrlHelpKey(key)) {
		return true;
	}
	if (options.inputFocused || key.ctrl || key.meta || key.option) {
		return false;
	}
	return key.sequence === "?" || key.name === "?";
}

/** Shortcuts the shell owns in every surface (dispatched by App.tsx through
 * {@link matchGlobalBinding}). */
export const GLOBAL_KEYMAP: readonly KeymapEntry[] = [
	{
		group: "Navigation",
		hint: "^K",
		hintPriority: 0,
		id: "palette",
		keys: "Ctrl+K",
		label: "open command palette",
		match: (key) => key.ctrl && key.name === "k",
		scope: "global",
	},
	{
		group: "Navigation",
		hint: "^N",
		hintPriority: 4,
		id: "node",
		keys: "Ctrl+N",
		label: "switch node",
		match: (key) => key.ctrl && key.name === "n",
		modes: NON_BOT_MODES,
		paletteAction: "action:node",
		scope: "global",
	},
	{
		group: "Navigation",
		hint: "^T",
		hintPriority: 2,
		id: "new-tab",
		keys: "Ctrl+T",
		label: "open a new chat tab",
		match: (key) => key.ctrl && !key.shift && key.name === "t",
		paletteAction: "action:new-chat",
		scope: "global",
	},
	{
		group: "Navigation",
		id: "restore-tab",
		keys: "Ctrl+Shift+T",
		label: "restore the last closed tab",
		match: (key) => key.ctrl && key.shift && key.name === "t",
		scope: "global",
	},
	{
		group: "Navigation",
		hint: "^W",
		hintPriority: 3,
		id: "close-tab",
		keys: "Ctrl+W",
		label: "close the active tab",
		match: (key) => key.ctrl && key.name === "w",
		scope: "global",
	},
	{
		group: "Navigation",
		id: "cycle-tab",
		keys: "Ctrl+Tab / Ctrl+Shift+Tab",
		label: "next / previous tab",
		match: (key) => key.ctrl && key.name === "tab",
		scope: "global",
	},
	{
		group: "Navigation",
		id: "focus-tab",
		keys: "Alt+1…9",
		label: "jump to tab 1–9 of the focused pane",
		match: (key) => isAlt(key) && /^[1-9]$/.test(key.name),
		scope: "global",
	},
	{
		group: "Navigation",
		id: "split",
		keys: "Ctrl+Alt+S",
		label: "split / unsplit the workspace",
		match: (key) => key.ctrl && key.option && key.name === "s",
		scope: "global",
	},
	{
		group: "Navigation",
		id: "focus-pane",
		keys: "Alt+Arrow",
		label: "focus the nearest pane in that direction",
		match: (key) => !key.ctrl && key.option && isArrowKey(key.name),
		scope: "global",
	},
	{
		group: "Navigation",
		id: "move-tab",
		keys: "Ctrl+Shift+→ / ↓ / ↑",
		label: "move tab to Right / Bottom / Center",
		match: (key) => key.ctrl && key.shift && moveTargetFor(key.name) !== null,
		scope: "global",
	},
	{
		group: "Navigation",
		hint: "^B",
		hintPriority: 6,
		id: "sidebar",
		// Alt+B is the alias for tmux / herdr, which take Ctrl+B as their prefix.
		keys: "Ctrl+B / Alt+B",
		label: "show / hide the sidebar",
		match: (key) =>
			(key.ctrl && !key.shift && key.name === "b") ||
			(isAlt(key) && key.name === "b"),
		paletteAction: "action:sidebar",
		scope: "global",
	},
	{
		group: "Navigation",
		id: "sidebar-focus",
		keys: "F6 / Alt+0",
		label: "focus the sidebar (↑↓ move, Enter open, ←→ fold, Esc back)",
		match: (key) => key.name === "f6" || (isAlt(key) && key.name === "0"),
		scope: "global",
	},
	{
		group: "Navigation",
		hint: "^⇧M",
		hintPriority: 5,
		id: "mode",
		keys: "Ctrl+Shift+M",
		label: "switch between Bot, Agent and OS",
		match: (key) => key.ctrl && key.shift && key.name === "m",
		paletteAction: "action:product-mode",
		scope: "global",
	},
	{
		group: "Navigation",
		hint: "F1",
		// Right after palette and quit, ahead of surface hints: discoverability.
		hintPriority: 1.2,
		id: "keymap",
		keys: "F1 / ? / Ctrl+?",
		label: "keyboard shortcuts (? outside text fields)",
		match: (key) => isHelpKey(key),
		paletteAction: "action:keymap",
		scope: "global",
	},
	{
		group: "Navigation",
		hint: "^C×2",
		hintPriority: 1,
		id: "quit",
		keys: "Ctrl+C ×2",
		label: "quit",
		match: (key) => key.ctrl && key.name === "c",
		paletteAction: "action:quit",
		scope: "global",
	},
];

/** Short labels for the status bar ("^K palette"). */
const GLOBAL_HINT_LABELS: Record<string, string> = {
	"close-tab": "close",
	keymap: "keys",
	mode: "mode",
	"new-tab": "new",
	node: "node",
	palette: "palette",
	quit: "quit",
	sidebar: "sidebar",
};

/** The global status-bar hints, generated from {@link GLOBAL_KEYMAP}. */
export function globalHints(mode?: ProductMode): KeyHint[] {
	const hints: KeyHint[] = [];
	for (const entry of GLOBAL_KEYMAP) {
		if (entry.hint && entryInMode(entry, mode)) {
			hints.push({
				keys: entry.hint,
				label: GLOBAL_HINT_LABELS[entry.id] ?? entry.label,
				priority: entry.hintPriority,
			});
		}
	}
	return hints;
}

/**
 * The id of the shell binding a key triggers, or null. The keymap entry for
 * F1 / Ctrl+? is matched without the bare "?" form; pass `inputFocused` so the
 * bare "?" counts only when no text field owns character input.
 */
export function matchGlobalBinding(
	key: KeyChord,
	options: { inputFocused?: boolean } = {}
): string | null {
	if (isHelpKey(key, { inputFocused: options.inputFocused ?? true })) {
		return "keymap";
	}
	for (const entry of GLOBAL_KEYMAP) {
		if (entry.id !== "keymap" && entry.match?.(key)) {
			return entry.id;
		}
	}
	return null;
}

/** The shortcuts users can invoke while the chat surface owns the keyboard. */
export const CHAT_KEYMAP: readonly KeymapEntry[] = [
	{
		group: "Chat",
		id: "chat.send",
		keys: "Enter",
		label: "send message",
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.newline",
		keys: "Shift+Enter / Alt+Enter / Ctrl+J",
		label: "insert a newline",
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.history",
		keys: "↑ / ↓",
		label: "prompt history (from the first / last line)",
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.escape",
		keys: "Esc",
		label: "interrupt (pauses queue) / close overlay",
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.scroll",
		keys: "PgUp / PgDn",
		label: "scroll transcript (Ctrl+Alt+U / D half page)",
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.scroll-ends",
		keys: "Ctrl+Home / Ctrl+End",
		label: "transcript top / jump to latest",
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.agent",
		keys: "Ctrl+A",
		label: "choose agent",
		modes: NON_BOT_MODES,
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.acp",
		keys: "Ctrl+R",
		label: "choose ACP settings",
		// Bot mode answers Ctrl+R with a "Console or OS only" notice.
		modes: NON_BOT_MODES,
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.new",
		keys: "Ctrl+L",
		label: "start a new conversation",
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.interrupt",
		keys: "Ctrl+C",
		label: "copy selection / clear draft / stop streaming",
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.queue",
		keys: "Ctrl+Q",
		label: "focus queued prompts",
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.expand",
		keys: "Ctrl+O",
		label: "expand or collapse long prompts",
		scope: "chat",
	},
	{
		group: "Chat",
		id: "chat.resume-recent",
		keys: "Alt+1 / 2 / 3",
		label: "resume a recent conversation (empty chat, single tab)",
		scope: "chat",
	},
];

/** Slash commands hidden in Bot mode (routing and model controls live in
 * Console/OS). */
export const BOT_HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
	"agent",
	"group",
	"model",
	"reasoning",
]);

/** Every built-in slash command, generated from the command registry. */
export const COMMAND_KEYMAP: readonly KeymapEntry[] = commandHelpRows().map(
	(row) => ({
		group: "Commands",
		id: `command.${row.name}`,
		keys: `/${row.name}`,
		label: row.description,
		modes: BOT_HIDDEN_COMMANDS.has(row.name) ? NON_BOT_MODES : undefined,
		scope: "chat",
	})
);

/** The whole registry in overlay display order: Navigation, Chat, Commands. */
export const ALL_KEYMAP: readonly KeymapEntry[] = [
	...GLOBAL_KEYMAP,
	...CHAT_KEYMAP,
	...COMMAND_KEYMAP,
];

function entryInMode(entry: KeymapEntry, mode: ProductMode | undefined) {
	return !(mode && entry.modes) || entry.modes.includes(mode);
}

/** Entries that apply in a product mode (all entries when mode is omitted). */
export function keymapForMode(
	mode?: ProductMode,
	entries: readonly KeymapEntry[] = ALL_KEYMAP
): KeymapEntry[] {
	return entries.filter((entry) => entryInMode(entry, mode));
}

/** Case-insensitive substring filter over keys, label and group. */
export function filterKeymap(
	entries: readonly KeymapEntry[],
	query: string
): KeymapEntry[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) {
		return [...entries];
	}
	return entries.filter((entry) =>
		[entry.keys, entry.label, entry.group].some((field) =>
			field.toLowerCase().includes(needle)
		)
	);
}

/** The display keys of the shortcut that runs a palette action, if any. */
export function paletteShortcut(actionId: string): string | undefined {
	return GLOBAL_KEYMAP.find((entry) => entry.paletteAction === actionId)?.keys;
}

export function keymapGroups(
	entries: readonly KeymapEntry[] = ALL_KEYMAP
): { group: string; entries: KeymapEntry[] }[] {
	const groups: { group: string; entries: KeymapEntry[] }[] = [];
	for (const entry of entries) {
		let group = groups.find((candidate) => candidate.group === entry.group);
		if (!group) {
			group = { group: entry.group, entries: [] };
			groups.push(group);
		}
		group.entries.push(entry);
	}
	return groups;
}
