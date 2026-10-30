// CommandPalette registry - the palette entry types, the extra-action
// registry, session recents, shortcut column and the static NAV destinations.

import { GLOBAL_KEYMAP, paletteShortcut } from "../core/keymap.ts";

export type PaletteGroup = "Suggested" | "Navigation" | "Actions" | "Plugins";

export interface PaletteAction {
	/** Extra search terms that match without appearing in the label. */
	aliases?: string[];
	/** Section shown when the query is empty (extra actions default to Plugins). */
	group?: PaletteGroup;
	id: string;
	label: string;
	run: () => void;
	/** Key chord shown muted and right-aligned, e.g. "Ctrl+W". */
	shortcut?: string;
}

// Module-level registry for extra palette actions (parity with router.ts). A
// downstream module calls registerPaletteAction(...) once at import time; the
// palette folds these in after the built-ins.
export const extraActions: PaletteAction[] = [];

/** Contribute an extra action to the palette. Idempotent by id. */
export function registerPaletteAction(action: PaletteAction): void {
	if (!extraActions.some((existing) => existing.id === action.id)) {
		extraActions.push(action);
	}
}

const MAX_SUGGESTED = 3;
// Unfiltered section order; Suggested is filled from recently run ids.
const GROUP_ORDER: readonly PaletteGroup[] = [
	"Navigation",
	"Actions",
	"Plugins",
];

// Recently run entry ids, most recent first. Module-level (session-scoped, not
// persisted) so it survives the palette closing and reopening.
export const recentIds: string[] = [];

export function rememberRecent(id: string): void {
	const existing = recentIds.indexOf(id);
	if (existing !== -1) {
		recentIds.splice(existing, 1);
	}
	recentIds.unshift(id);
	recentIds.length = Math.min(recentIds.length, MAX_SUGGESTED * 3);
}

/** Forget recently run entries (tests isolate the Suggested section with it). */
export function clearPaletteRecents(): void {
	recentIds.length = 0;
}

/** The keymap registry's display keys for a shell binding, so the palette's
 * shortcut column always matches what the shell dispatches. */
function globalKeys(id: string): string | undefined {
	return GLOBAL_KEYMAP.find((entry) => entry.id === id)?.keys;
}

export const SHORTCUTS = {
	closeTab: globalKeys("close-tab"),
	keymap: paletteShortcut("action:keymap"),
	newChat: paletteShortcut("action:new-chat"),
	productMode: paletteShortcut("action:product-mode"),
	quit: paletteShortcut("action:quit"),
	reopenTab: globalKeys("restore-tab"),
	sidebar: paletteShortcut("action:sidebar"),
	split: globalKeys("split"),
	switchNode: paletteShortcut("action:node"),
} as const;

export interface PaletteRow {
	entry: PaletteAction;
	group: PaletteGroup;
	key: string;
}

export function groupedRows(entries: readonly PaletteAction[]): PaletteRow[] {
	const rows: PaletteRow[] = [];
	for (const id of recentIds) {
		const entry = entries.find((candidate) => candidate.id === id);
		if (entry && rows.length < MAX_SUGGESTED) {
			rows.push({ entry, group: "Suggested", key: `suggested:${entry.id}` });
		}
	}
	for (const group of GROUP_ORDER) {
		for (const entry of entries) {
			if ((entry.group ?? "Plugins") === group) {
				rows.push({ entry, group, key: entry.id });
			}
		}
	}
	return rows;
}

// Desktop NAV_ITEMS: label -> path (openTab destinations).
export const NAV_DESTINATIONS: { label: string; path: string }[] = [
	{ label: "Chat", path: "/chat" },
	{ label: "Agents", path: "/agents" },
	{ label: "Engines", path: "/engines" },
	{ label: "Models", path: "/models" },
	{ label: "Skills", path: "/skills" },
	{ label: "Spaces", path: "/spaces" },
	{ label: "Tools", path: "/tools" },
	{ label: "Workflows", path: "/workflows" },
	{ label: "Calendar", path: "/calendar" },
	{ label: "Timeline", path: "/timeline" },
	{ label: "Monitors", path: "/monitors" },
	{ label: "Tasks", path: "/tasks" },
	{ label: "Inbox", path: "/inbox" },
	{ label: "Meetings", path: "/meetings" },
];
