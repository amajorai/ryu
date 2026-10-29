// Interface mode — how much of the app is on screen at all.
//
// Ryu ships two audiences in one binary: someone who wants a chat box, and
// someone who wants the model, the approval mode, the thinking budget and the
// raw tool transcript. Every one of those controls used to be unconditionally
// present, so the first audience met the second audience's cockpit on install.
// This is the one knob that decides which app they get, and it defaults to
// Ryu Work — the everyday, non-technical reading — because that is the larger
// audience and the one that cannot recover from a wrong default on their own.
//
// It is a binary PRESET over prefs that already exist: switching it WRITES the
// downstream prefs rather than shadowing them, so anything it turns on is still
// findable, nameable and reversible in Settings → Appearance. Two consequences
// worth stating out loud:
//
//   - Switching modes overwrites a hand-tuned Detail level. Same trade the
//     Detail preset itself makes; the alternative is a mode that claims to
//     simplify the app and then leaves the transcript exactly as it was.
//   - Transcript preferences are NEVER retro-applied on boot. `seedInterfaceLevel()`
//     writes only keys that have never been written, so an existing user's setup
//     survives the upgrade. The Ryu Work vocabulary is the one intentional
//     exception: it remains forced on whenever Ryu Work is already selected.
//
// What the level itself gates live (no write involved) is the composer: at Ryu
// Work the chat bar offers the agent picker and nothing else — no model, no
// approval mode, no thinking budget, no profile picker. See
// `composer-agent-controls.tsx`. (The node dropdown no longer needs a gate: its
// Engines, Voice & Sandbox and Toolkits blocks moved to the expanded computer
// dialog at every level. See `NodeSelector.tsx`.)

import { setBotTerminology } from "@ryu/ui/hooks/use-bot-terminology.ts";
import { setPersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import {
	DEFAULT_SIDEBAR_MODE,
	setSidebarMode,
} from "@/src/hooks/useSidebarMode.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import { TOOL_DETAIL_PRESETS } from "@/src/lib/tool-detail-ladder.ts";

export const INTERFACE_LEVEL_KEY = "ryu:interface-level";

/** localStorage keys this preset writes. Owned elsewhere; only seeded here. */
const HIDE_TOOL_DETAIL_KEY = "ryu:hide-tool-detail";
const GROUP_TOOL_USES_KEY = "ryu:group-tool-uses";
const EXPAND_FILE_EDITS_KEY = "ryu:expand-file-edits";
const EXPAND_COMMANDS_KEY = "ryu:expand-commands";
const EXPAND_CODE_BLOCKS_KEY = "ryu:expand-code-blocks";
const INFERENCE_STATS_KEY = "ryu:inference-stats";

/**
 * The two user-facing modes, least → most surface. The ids remain `simple` and
 * `expert` because they are persisted locally and used by the UI gates.
 */
export const INTERFACE_LEVELS = [
	{
		id: "simple",
		label: "Ryu Work",
	},
	{
		id: "expert",
		label: "Code",
	},
] as const;

export type InterfaceLevel = (typeof INTERFACE_LEVELS)[number]["id"];

/** Focused everyday work, not the full developer cockpit — see the header. */
export const DEFAULT_INTERFACE_LEVEL: InterfaceLevel = "simple";

/** The transcript density each level implies, applied when the level moves. */
const LEVEL_TOOL_DETAIL = {
	// `preset` is still carried at Ryu Work even though nothing is shown: switching
	// back up must land somewhere sane rather than on whatever was last stored.
	simple: { hidden: true, preset: "compact" },
	expert: { hidden: false, preset: "detailed" },
} satisfies Record<
	InterfaceLevel,
	{ hidden: boolean; preset: keyof typeof TOOL_DETAIL_PRESETS }
>;

function normalizeStoredLevel(value: string | null): InterfaceLevel | null {
	if (value === "simple" || value === "expert") {
		return value;
	}
	// Builds before the binary switch persisted these intermediate detents. Any
	// non-simple choice means the user opted into the expanded Code surface.
	if (value === "standard" || value === "advanced") {
		return "expert";
	}
	return null;
}

const listeners = new Set<() => void>();

function readFromStorage(): InterfaceLevel {
	if (isRyuBot()) {
		return "simple";
	}
	try {
		const raw = localStorage.getItem(INTERFACE_LEVEL_KEY);
		return normalizeStoredLevel(raw) ?? DEFAULT_INTERFACE_LEVEL;
	} catch {
		return DEFAULT_INTERFACE_LEVEL;
	}
}

let cache: InterfaceLevel = readFromStorage();

/** The current level without subscribing (module scope, event handlers). */
export function readInterfaceLevel(): InterfaceLevel {
	return cache;
}

export function getInterfaceLevelSnapshot(): InterfaceLevel {
	return cache;
}

export function getInterfaceLevelServerSnapshot(): InterfaceLevel {
	return isRyuBot() ? "simple" : DEFAULT_INTERFACE_LEVEL;
}

export function subscribeInterfaceLevel(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === INTERFACE_LEVEL_KEY) {
			cache = readFromStorage();
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

/** Write the downstream transcript prefs a level implies. */
function applyLevelPrefs(level: InterfaceLevel): void {
	const { hidden, preset } = LEVEL_TOOL_DETAIL[level];
	const detail = TOOL_DETAIL_PRESETS[preset];
	setPersistedToggle(HIDE_TOOL_DETAIL_KEY, hidden);
	setPersistedToggle(GROUP_TOOL_USES_KEY, detail.group);
	setPersistedToggle(EXPAND_FILE_EDITS_KEY, detail.edits);
	setPersistedToggle(EXPAND_COMMANDS_KEY, detail.commands);
	setPersistedToggle(EXPAND_CODE_BLOCKS_KEY, detail.code);
	// Per-turn token/latency readouts are a Code affordance; Ryu Work turns them
	// back off, so stepping down actually simplifies the transcript.
	setPersistedToggle(INFERENCE_STATS_KEY, level === "expert");
	// Ryu Work is the everyday vocabulary preset as well as the smallest surface.
	// Code preserves the user's explicit Bot terminology choice.
	if (level === "simple") {
		setBotTerminology(true);
		// The built-in Bot mode is the non-technical landing surface. Code leaves
		// the user's explicit sidebar choice alone rather than silently restoring
		// the full sections layout.
		setSidebarMode(DEFAULT_SIDEBAR_MODE);
	}
}

/**
 * Persist the level, apply what it implies, and notify every consumer.
 *
 * `applyPrefs: false` writes the level alone. Exactly one caller wants that:
 * Appearance's "Reset to defaults", where every downstream pref already has its
 * own registered reset — writing them from here too would make the outcome
 * depend on which entry ran last.
 */
export function setInterfaceLevel(
	level: InterfaceLevel,
	{ applyPrefs = true }: { applyPrefs?: boolean } = {}
): void {
	const nextLevel: InterfaceLevel = isRyuBot() ? "simple" : level;
	cache = nextLevel;
	try {
		localStorage.setItem(INTERFACE_LEVEL_KEY, nextLevel);
	} catch {
		// Best-effort persistence; in-memory state still updates.
	}
	if (applyPrefs) {
		applyLevelPrefs(nextLevel);
	}
	for (const cb of listeners) {
		cb();
	}
}

/**
 * First-run seeding: give a fresh install the Ryu Work transcript without ever
 * rewriting a pref the user has already set.
 *
 * Runs once, on import. Only keys with NO stored value are written — an upgrade
 * from a build that predates this ladder keeps every toggle the user touched,
 * and only the ones they never touched pick up the Ryu Work default. Also
 * deliberately does not write `INTERFACE_LEVEL_KEY` itself: an absent key
 * already reads as Ryu Work, and leaving it absent keeps "has this user ever
 * chosen a level?" answerable.
 */
export function seedInterfaceLevel(): void {
	let stored: string | null;
	try {
		stored = localStorage.getItem(INTERFACE_LEVEL_KEY);
	} catch {
		return;
	}
	if (stored !== null) {
		if (stored === "standard" || stored === "advanced") {
			// Collapse the removed intermediate detents to Code and apply its
			// downstream prefs once, so the stored mode and visible surface agree.
			setInterfaceLevel("expert");
			return;
		}
		if (readFromStorage() === "simple") {
			setBotTerminology(true);
			setSidebarMode(DEFAULT_SIDEBAR_MODE);
		}
		return;
	}
	const { hidden, preset } = LEVEL_TOOL_DETAIL[DEFAULT_INTERFACE_LEVEL];
	const detail = TOOL_DETAIL_PRESETS[preset];
	const seeds: [string, boolean][] = [
		[HIDE_TOOL_DETAIL_KEY, hidden],
		[GROUP_TOOL_USES_KEY, detail.group],
		[EXPAND_FILE_EDITS_KEY, detail.edits],
		[EXPAND_COMMANDS_KEY, detail.commands],
		[EXPAND_CODE_BLOCKS_KEY, detail.code],
	];
	for (const [key, value] of seeds) {
		try {
			if (localStorage.getItem(key) === null) {
				setPersistedToggle(key, value);
			}
		} catch {
			// Best-effort; a blocked storage just leaves the shipped default.
		}
	}
	// The shipped default is Ryu Work, so its plain-language preset is on from the
	// first boot even before the level key is written.
	setBotTerminology(true);
	setSidebarMode(DEFAULT_SIDEBAR_MODE);
}

/** Where the binary switch sits for a level. Kept for existing consumers. */
export function interfaceLevelIndex(level: InterfaceLevel): number {
	const index = INTERFACE_LEVELS.findIndex((l) => l.id === level);
	return index === -1 ? 0 : index;
}

/** Does this level put the model picker in the composer? */
export function showsModelPicker(level: InterfaceLevel): boolean {
	return level !== "simple";
}

/**
 * Does this level show the composer's tuning sections — approval mode, thinking
 * budget, and agent-advertised config options?
 *
 * Ryu Work hides them. Hiding is not disabling: the agent still runs
 * on whatever approval mode is configured, it simply is not surfaced in the chat
 * bar. Someone who needs to SEE which mode they are in raises the level.
 */
export function showsComposerTuning(level: InterfaceLevel): boolean {
	return level === "expert";
}

seedInterfaceLevel();
