// Display labels for chord keycaps. `@ryu/hotkeys/chord` tokens are stable
// English ids ("Down", "Space", "End"), and the same words are also catalog
// keys in another sense ("Down" as a service status, "Space" as a region), so
// a keycap must never reach the catalog or the DOM localizer as a bare token.
// Arrows become glyphs; named and modifier keys translate as whole key-sense
// messages (the keycap opts out of the DOM localizer, so "Shift" would
// otherwise lose its "Umschalt" / "Maj" rendering).

/** The literal translator (`useLiteralMessages()` or `translate`). */
export type ChordKeyTranslator = (source: string) => string;

const ARROW_GLYPHS: Readonly<Record<string, string>> = {
	Down: "↓",
	Left: "←",
	Right: "→",
	Up: "↑",
};

/** Named and modifier keys, each translated in its keyboard-key sense. */
const NAMED_KEY_MESSAGES: Readonly<
	Record<string, (tl: ChordKeyTranslator) => string>
> = {
	Alt: (tl) => tl("Alt key"),
	Backspace: (tl) => tl("Backspace key"),
	Ctrl: (tl) => tl("Ctrl key"),
	Delete: (tl) => tl("Delete key"),
	End: (tl) => tl("End key"),
	Enter: (tl) => tl("Enter key"),
	Esc: (tl) => tl("Escape key"),
	Escape: (tl) => tl("Escape key"),
	Home: (tl) => tl("Home key"),
	PageDown: (tl) => tl("Page Down key"),
	PageUp: (tl) => tl("Page Up key"),
	Shift: (tl) => tl("Shift key"),
	Space: (tl) => tl("Space key"),
	Tab: (tl) => tl("Tab key"),
};

/**
 * The keycap label for one chord token. Untranslated key-sense messages fall
 * back to the short token, so English keycaps keep reading "Space", not
 * "Space key". Any other token (letters, macOS modifier glyphs) is returned
 * as is.
 */
export function chordKeyLabel(token: string, tl: ChordKeyTranslator): string {
	const arrow = ARROW_GLYPHS[token];
	if (arrow) {
		return arrow;
	}
	const message = NAMED_KEY_MESSAGES[token];
	if (!message) {
		return token;
	}
	const english = message((source) => source);
	const translated = message(tl);
	return translated === english ? token : translated;
}
