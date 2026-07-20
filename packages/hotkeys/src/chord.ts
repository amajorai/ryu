// The cross-surface key-chord model for Ryu's unified hotkey system.
//
// A "chord" is a canonical, platform-agnostic string like "Mod+Shift+K". It is
// the single serialization every TypeScript surface (desktop, island, extension)
// stores and matches against. `Mod` maps to Cmd on macOS and Ctrl elsewhere, so
// one binding is correct on every OS — the same idea TanStack Hotkeys uses, built
// here so we depend on nothing.
//
// Two conversions live here because Ryu registers hotkeys in two worlds: the
// webview (matched against `KeyboardEvent`) and the native layer (Electron /
// Tauri global accelerators). `toElectronAccelerator` / `chordFromElectron`
// bridge to the OS-level format the island already persists.

/** A canonical chord string, e.g. `"Mod+Shift+K"`. */
export type Chord = string;

/** Modifier tokens in canonical order. `Mod` = Cmd on macOS, Ctrl elsewhere. */
const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift"] as const;
const MODIFIER_SET = new Set<string>(MODIFIER_ORDER);

/** Keys pressed alone that never form a chord on their own. */
const MODIFIER_ONLY_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

/** `KeyboardEvent.key` values whose canonical token differs from the raw key. */
const NAMED_KEYS: Record<string, string> = {
	" ": "Space",
	Spacebar: "Space",
	ArrowUp: "Up",
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	Escape: "Esc",
	Enter: "Enter",
	Tab: "Tab",
	Backspace: "Backspace",
	Delete: "Delete",
};

/** True when the code is running on macOS (⌘ surfaces, ⌥/⇧ glyphs). */
export function isMac(): boolean {
	if (typeof navigator === "undefined") {
		return false;
	}
	return /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** Canonical display token for a chord token, given the platform. */
function displayToken(token: string, mac: boolean): string {
	if (token === "Mod") {
		return mac ? "⌘" : "Ctrl";
	}
	if (token === "Ctrl") {
		return mac ? "⌃" : "Ctrl";
	}
	if (token === "Alt") {
		return mac ? "⌥" : "Alt";
	}
	if (token === "Shift") {
		return mac ? "⇧" : "Shift";
	}
	return token;
}

/** Normalize the "main" (non-modifier) key of a chord to its canonical form. */
function normalizeMainKey(key: string): string {
	if (NAMED_KEYS[key]) {
		return NAMED_KEYS[key];
	}
	return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Re-order and re-case a chord into canonical form so two spellings of the same
 * chord compare equal. Unknown modifier casing is tolerated (`ctrl` -> `Ctrl`).
 */
export function normalizeChord(chord: Chord): Chord {
	const seen = new Set<string>();
	let main = "";
	for (const raw of chord.split("+")) {
		const part = raw.trim();
		if (part.length === 0) {
			continue;
		}
		const canonicalMod = MODIFIER_ORDER.find(
			(m) => m.toLowerCase() === part.toLowerCase()
		);
		if (canonicalMod) {
			seen.add(canonicalMod);
		} else {
			main = normalizeMainKey(part);
		}
	}
	const parts = MODIFIER_ORDER.filter((m) => seen.has(m)) as string[];
	if (main.length > 0) {
		parts.push(main);
	}
	return parts.join("+");
}

/**
 * Build the canonical chord for a keydown event, or `null` while the user is
 * still holding only modifiers (no main key yet). `Ctrl` and `Cmd` both fold to
 * `Mod` so a single binding works cross-platform.
 */
export function eventToChord(e: KeyboardEvent): Chord | null {
	if (MODIFIER_ONLY_KEYS.has(e.key)) {
		return null;
	}
	const parts: string[] = [];
	if (e.ctrlKey || e.metaKey) {
		parts.push("Mod");
	}
	if (e.altKey) {
		parts.push("Alt");
	}
	if (e.shiftKey) {
		parts.push("Shift");
	}
	parts.push(normalizeMainKey(e.key));
	return parts.join("+");
}

/** True when a chord matches a keydown event. */
export function chordMatches(chord: Chord, e: KeyboardEvent): boolean {
	const eventChord = eventToChord(e);
	if (eventChord === null) {
		return false;
	}
	return normalizeChord(eventChord) === normalizeChord(chord);
}

/** True when the chord carries a modifier (so it is safe to fire inside inputs). */
export function chordHasModifier(chord: Chord): boolean {
	return chord
		.split("+")
		.some((part) => MODIFIER_SET.has(normalizeChord(part)));
}

/** Display keycaps for a chord (e.g. `["⌘", "⇧", "K"]` on macOS). */
export function chordTokens(chord: Chord, mac = isMac()): string[] {
	return normalizeChord(chord)
		.split("+")
		.filter((t) => t.length > 0)
		.map((t) => displayToken(t, mac));
}

/** A human-readable one-line rendering of a chord (`"⌘ ⇧ K"`). */
export function formatChord(chord: Chord, mac = isMac()): string {
	return chordTokens(chord, mac).join(mac ? " " : "+");
}

/** True when a keyboard event targets an editable element (input/textarea/CE). */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	const tag = target.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
		return true;
	}
	return target.isContentEditable;
}

// --- Native accelerator bridge ----------------------------------------------
// Electron's `globalShortcut` and Tauri's global-shortcut plugin take an
// accelerator string (`CommandOrControl+Shift+A`). The island persists chords in
// that format, so these converters let the desktop settings render and edit them
// through the same chord model.

const CHORD_TO_ELECTRON_KEY: Record<string, string> = {
	Up: "Up",
	Down: "Down",
	Left: "Left",
	Right: "Right",
	Space: "Space",
	Esc: "Esc",
	Enter: "Return",
};

const ELECTRON_TO_CHORD_KEY: Record<string, string> = {
	Return: "Enter",
	Escape: "Esc",
};

/** Convert a canonical chord to an Electron/Tauri accelerator string. */
export function toElectronAccelerator(chord: Chord): string {
	return normalizeChord(chord)
		.split("+")
		.map((token) => {
			if (token === "Mod") {
				return "CommandOrControl";
			}
			if (token === "Ctrl") {
				return "Control";
			}
			return CHORD_TO_ELECTRON_KEY[token] ?? token;
		})
		.join("+");
}

/** Convert an Electron/Tauri accelerator string into a canonical chord. */
export function chordFromElectron(accelerator: string): Chord {
	const parts = accelerator.split("+").map((token) => {
		if (token === "CommandOrControl" || token === "CmdOrCtrl") {
			return "Mod";
		}
		if (token === "Command" || token === "Cmd" || token === "Super") {
			return "Mod";
		}
		if (token === "Control") {
			return "Ctrl";
		}
		return ELECTRON_TO_CHORD_KEY[token] ?? token;
	});
	return normalizeChord(parts.join("+"));
}
