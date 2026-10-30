// Reusable global-shortcut capture control: renders the current accelerator as
// keycaps inside a button that, when focused, records the next key chord and
// reports it as an Electron accelerator string (e.g. "CommandOrControl+Shift+A").
// Used by the Island settings for the command-summon and push-to-talk shortcuts.
// Pure presentation plus a local capturing state; the parent owns persistence.

import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";

/** Pretty labels for accelerator tokens shown as keycaps. */
const TOKEN_LABELS = new Map<string, string>([
	["CommandOrControl", "Ctrl"],
	["Alt", "Alt"],
	["Shift", "Shift"],
	["Space", "Space"],
	["Plus", "+"],
]);

/**
 * Non-character keys whose `KeyboardEvent.code` and `KeyboardEvent.key` share
 * one name, mapped to their Electron accelerator name. Looked up by `code`, and
 * by `key` when an event carries no physical code.
 */
const NAMED_KEYS = new Map<string, string>([
	["ArrowUp", "Up"],
	["ArrowDown", "Down"],
	["ArrowLeft", "Left"],
	["ArrowRight", "Right"],
	["Escape", "Esc"],
	["Enter", "Return"],
	["Tab", "Tab"],
	["Backspace", "Backspace"],
	["Delete", "Delete"],
	["Insert", "Insert"],
	["Home", "Home"],
	["End", "End"],
	["PageUp", "PageUp"],
	["PageDown", "PageDown"],
	["PrintScreen", "PrintScreen"],
	["CapsLock", "Capslock"],
	["NumLock", "Numlock"],
	["ScrollLock", "Scrolllock"],
	["MediaPlayPause", "MediaPlayPause"],
	["MediaStop", "MediaStop"],
	["MediaTrackNext", "MediaNextTrack"],
	["MediaTrackPrevious", "MediaPreviousTrack"],
	["AudioVolumeUp", "VolumeUp"],
	["AudioVolumeDown", "VolumeDown"],
	["AudioVolumeMute", "VolumeMute"],
	// Legacy `code` names some engines still report for the volume keys.
	["VolumeUp", "VolumeUp"],
	["VolumeDown", "VolumeDown"],
	["VolumeMute", "VolumeMute"],
]);

/**
 * Physical keys (`KeyboardEvent.code`) whose Electron accelerator name is not
 * derived by the letter/digit/function-key rules below.
 */
const CODE_KEYS = new Map<string, string>([
	["Space", "Space"],
	["Minus", "-"],
	["Equal", "="],
	["BracketLeft", "["],
	["BracketRight", "]"],
	["Backslash", "\\"],
	["Semicolon", ";"],
	["Quote", "'"],
	["Comma", ","],
	["Period", "."],
	["Slash", "/"],
	["Backquote", "`"],
	["NumpadEnter", "Return"],
	["NumpadAdd", "numadd"],
	["NumpadSubtract", "numsub"],
	["NumpadMultiply", "nummult"],
	["NumpadDivide", "numdiv"],
	["NumpadDecimal", "numdec"],
	...NAMED_KEYS,
]);

const MODIFIER_ONLY_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);
const LETTER_CODE_RE = /^Key([A-Z])$/;
const DIGIT_CODE_RE = /^Digit([0-9])$/;
const NUMPAD_DIGIT_CODE_RE = /^Numpad([0-9])$/;
// F1-F24: the same name as a `code` and as a `key`.
const FUNCTION_KEY_RE = /^F([1-9]|1[0-9]|2[0-4])$/;
// One printable, non-space ASCII character (U+0021..U+007E).
const PRINTABLE_ASCII_KEY_RE = /^[!-~]$/;
// A "+" that separates tokens: one followed by another character, so a literal
// "+" main key (e.g. a stored "CommandOrControl++") stays one keycap.
const TOKEN_SEPARATOR_RE = /\+(?=.)/;

/**
 * The Electron key name for the pressed physical key, or `null` when it has no
 * valid accelerator name.
 *
 * Derived from `KeyboardEvent.code`, not `.key`: modifiers rewrite `.key` into
 * composed characters (macOS Option+D is "∂", Option+Space is U+00A0, Shift+= is
 * "+"), none of which Electron's accelerator parser accepts. `code` names the
 * physical key, so on a non-QWERTY layout (AZERTY, Dvorak) the stored letter can
 * differ from the printed keycap; that is an accepted trade-off for a chord that
 * always registers.
 */
function mainKeyFromEvent(code: string, key: string): string | null {
	const mapped = CODE_KEYS.get(code);
	if (mapped) {
		return mapped;
	}
	const letter = LETTER_CODE_RE.exec(code)?.[1];
	if (letter) {
		return letter;
	}
	const digit = DIGIT_CODE_RE.exec(code)?.[1];
	if (digit) {
		return digit;
	}
	const numpadDigit = NUMPAD_DIGIT_CODE_RE.exec(code)?.[1];
	if (numpadDigit) {
		return `num${numpadDigit}`;
	}
	if (FUNCTION_KEY_RE.test(code)) {
		return code;
	}
	return code ? null : mainKeyFromKeyName(key);
}

/**
 * Fallback for events without a physical `code` (some virtual keyboards and
 * synthetic events): map named keys and single printable ASCII characters by
 * `KeyboardEvent.key`. "Dead" and non-ASCII composed characters are rejected.
 */
function mainKeyFromKeyName(key: string): string | null {
	if (key === " ") {
		return "Space";
	}
	if (key === "+") {
		return "Plus";
	}
	const named = NAMED_KEYS.get(key);
	if (named) {
		return named;
	}
	if (FUNCTION_KEY_RE.test(key)) {
		return key;
	}
	if (PRINTABLE_ASCII_KEY_RE.test(key)) {
		return key.toUpperCase();
	}
	return null;
}

/**
 * Build an Electron accelerator string from a keydown event, or `null` for a
 * modifier-only press (the user is still composing the chord) or a key with no
 * valid accelerator name.
 */
export function eventToAccelerator(
	e: Pick<
		React.KeyboardEvent,
		"altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
	>
): string | null {
	if (MODIFIER_ONLY_KEYS.has(e.key)) {
		return null;
	}
	const main = mainKeyFromEvent(e.code, e.key);
	if (!main) {
		return null;
	}
	const parts: string[] = [];
	if (e.ctrlKey || e.metaKey) {
		parts.push("CommandOrControl");
	}
	if (e.altKey) {
		parts.push("Alt");
	}
	if (e.shiftKey) {
		parts.push("Shift");
	}
	parts.push(main);
	return parts.join("+");
}

/** Split an accelerator into display keycaps. */
export function acceleratorTokens(accelerator: string): string[] {
	return accelerator
		.split(TOKEN_SEPARATOR_RE)
		.map((t) => TOKEN_LABELS.get(t) ?? t)
		.filter((t) => t.length > 0);
}

interface ShortcutCaptureProps {
	/** Accessible label for the capture button. */
	ariaLabel: string;
	/** Called with the new Electron accelerator string when a chord is captured. */
	onChange: (accelerator: string) => void;
	/** Optional reset handler; renders a "Reset" button when provided. */
	onReset?: () => void;
	/** The current accelerator string to display. */
	value: string;
}

/** Keycap button that records the next key chord as an Electron accelerator. */
export function ShortcutCapture({
	ariaLabel,
	onChange,
	onReset,
	value,
}: ShortcutCaptureProps) {
	const [capturing, setCapturing] = useState(false);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (!capturing) {
			return;
		}
		e.preventDefault();
		if (e.key === "Escape") {
			setCapturing(false);
			return;
		}
		const accelerator = eventToAccelerator(e);
		if (accelerator) {
			onChange(accelerator);
			setCapturing(false);
		}
	};

	return (
		<div className="flex items-center gap-2">
			<button
				aria-label={ariaLabel}
				className="flex min-w-40 items-center justify-center gap-1 rounded-lg bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
				onBlur={() => setCapturing(false)}
				onClick={() => setCapturing(true)}
				onKeyDown={handleKeyDown}
				type="button"
			>
				{capturing ? (
					<span className="text-muted-foreground text-xs">Press keys…</span>
				) : (
					acceleratorTokens(value).map((token) => (
						<kbd
							className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs"
							key={token}
						>
							{token}
						</kbd>
					))
				)}
			</button>
			{onReset ? (
				<Button onClick={onReset} size="sm" variant="ghost">
					Reset
				</Button>
			) : null}
		</div>
	);
}
