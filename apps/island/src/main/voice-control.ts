// Global key-hook control for hold-to-talk capture + Tab agent-cycling.
//
// Electron's `globalShortcut` only delivers key-*down* events, so it can drive the
// toggle mode (press to start, press to stop) but not true push-to-talk (record
// while held, stop on release). For that we need a global key-*up* signal, which
// `uiohook-napi` provides via a low-level OS hook (CGEventTap on macOS,
// SetWindowsHookEx on Windows, X11 on Linux). This module owns that hook.
//
// The hook is a process-wide singleton — there is exactly one `uIOhook` — so both
// features that need hold-to-talk (voice input AND system-wide dictation) register
// as named *channels* here rather than each starting their own hook. Each channel
// carries its own activation keycode + release callback; the hook runs ONLY while
// at least one channel is in push-to-talk mode or a recording is in progress, so
// the island is never a background keylogger at rest.
//
// The activation "primary" key is the last token of the Electron accelerator
// (e.g. `"CommandOrControl+Shift+A"` → `A`), mapped to a uiohook keycode. Any
// accelerator whose primary key we cannot map degrades gracefully to toggle mode
// (the caller checks {@link acceleratorPrimaryKeycode} for null).

import { UiohookKey, uIOhook } from "uiohook-napi";

/** A uiohook keyboard event (the subset we read). */
interface HookKeyEvent {
	keycode: number;
	shiftKey: boolean;
}

/** Named/punctuation Electron accelerator tokens → uiohook key names. */
const NAMED_KEY_ALIASES: Record<string, keyof typeof UiohookKey> = {
	SPACE: "Space",
	TAB: "Tab",
	BACKSPACE: "Backspace",
	DELETE: "Delete",
	DEL: "Delete",
	INSERT: "Insert",
	RETURN: "Enter",
	ENTER: "Enter",
	ESC: "Escape",
	ESCAPE: "Escape",
	UP: "ArrowUp",
	DOWN: "ArrowDown",
	LEFT: "ArrowLeft",
	RIGHT: "ArrowRight",
	HOME: "Home",
	END: "End",
	PAGEUP: "PageUp",
	PAGEDOWN: "PageDown",
	CAPSLOCK: "CapsLock",
	NUMLOCK: "NumLock",
	SCROLLLOCK: "ScrollLock",
	PRINTSCREEN: "PrintScreen",
	";": "Semicolon",
	"=": "Equal",
	",": "Comma",
	"-": "Minus",
	".": "Period",
	"/": "Slash",
	"`": "Backquote",
	"~": "Backquote",
	"[": "BracketLeft",
	"\\": "Backslash",
	"]": "BracketRight",
	"'": "Quote",
};

/**
 * Map the primary (non-modifier) key of an Electron accelerator to a uiohook
 * keycode, or `null` if it cannot be mapped (the caller then keeps toggle mode).
 * The primary key is the last `+`-separated token; single letters/digits and
 * `F1`–`F24` resolve directly against {@link UiohookKey}, everything else through
 * {@link NAMED_KEY_ALIASES}.
 */
export function acceleratorPrimaryKeycode(accelerator: string): number | null {
	const tokens = accelerator
		.split("+")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	const primary = tokens.at(-1);
	if (!primary) {
		return null;
	}
	// Letters, digits, and F-keys match a UiohookKey entry by their own name.
	const direct = UiohookKey[primary.toUpperCase() as keyof typeof UiohookKey];
	if (typeof direct === "number") {
		return direct;
	}
	const alias =
		NAMED_KEY_ALIASES[primary.toUpperCase()] ?? NAMED_KEY_ALIASES[primary];
	if (alias) {
		return UiohookKey[alias];
	}
	return null;
}

const TAB_KEYCODE = UiohookKey.Tab;

/** One hold-to-talk channel (e.g. `"voice"`, `"dictation"`). */
interface HoldChannel {
	/** True between the activation key-down and its release. */
	holding: boolean;
	/** The activation key's uiohook keycode (null → toggle mode, never armed). */
	keycode: number | null;
	/** Called on the activation key's release (stop hold-to-talk). */
	onRelease: () => void;
	/** True when this channel is in hold-to-talk mode with a mappable key. */
	pttMode: boolean;
}

// Live state driving the singleton hook. The hook runs iff any channel is in
// push-to-talk mode OR any channel is recording.
const channels = new Map<string, HoldChannel>();
const recordingIds = new Set<string>();
let hookStarted = false;
let handlersAttached = false;

// Tab (Shift+Tab) rotates the routed agent, but only while the channel that owns
// Tab-cycling (voice input) is recording. Dictation does not use Tab-cycling.
let tabChannelId: string | null = null;
let onTabCycle: (direction: 1 | -1) => void = () => {
	// no-op until configured
};

/** Whether any channel is currently in push-to-talk mode. */
function anyPttMode(): boolean {
	for (const channel of channels.values()) {
		if (channel.pttMode) {
			return true;
		}
	}
	return false;
}

/** Attach the keyup/keydown handlers once; they gate on the live state. */
function ensureHandlers(): void {
	if (handlersAttached) {
		return;
	}
	handlersAttached = true;
	// Hold-to-talk release: stop whichever channel is holding the released key.
	// Gated on the per-channel `holding` flag (set on the shortcut press) rather
	// than any renderer mirror, so it neither misses a fast release nor fires on
	// unrelated presses of the same key when no hold is in progress.
	uIOhook.on("keyup", (event: HookKeyEvent) => {
		for (const channel of channels.values()) {
			if (
				channel.pttMode &&
				channel.holding &&
				channel.keycode !== null &&
				event.keycode === channel.keycode
			) {
				channel.holding = false;
				channel.onRelease();
			}
		}
	});
	// Tab (Shift+Tab) rotates the routed agent while the owning channel records.
	// uiohook reports the raw Tab keycode regardless of held modifiers, so this
	// works even mid-chord in push-to-talk mode. It does not consume the key — a
	// stray Tab may reach the focused app — an accepted trade for hooking without
	// stealing focus.
	uIOhook.on("keydown", (event: HookKeyEvent) => {
		if (
			tabChannelId !== null &&
			recordingIds.has(tabChannelId) &&
			event.keycode === TAB_KEYCODE
		) {
			onTabCycle(event.shiftKey ? -1 : 1);
		}
	});
}

/** Start or stop the OS hook so it runs only while a hold or recording is active. */
function reconcileHook(): void {
	const needed = anyPttMode() || recordingIds.size > 0;
	if (needed && !hookStarted) {
		ensureHandlers();
		try {
			uIOhook.start();
			hookStarted = true;
		} catch {
			// The OS denied the hook (e.g. missing Accessibility/Input Monitoring
			// grant). Capture still works via the global shortcut; hold-to-talk release
			// and Tab-cycling are simply inert until the permission is granted.
		}
	} else if (!needed && hookStarted) {
		try {
			uIOhook.stop();
		} catch {
			// Best effort; nothing to do if the hook was already torn down.
		}
		hookStarted = false;
	}
}

/** Configuration for a hold-to-talk channel. */
export interface HoldChannelConfig {
	/** The activation key's uiohook keycode (null when unmappable / toggle mode). */
	keycode: number | null;
	/** Called on the activation key's release (stop hold-to-talk). */
	onRelease: () => void;
	/** True when the active mode is hold-to-talk with a mappable key. */
	pttMode: boolean;
}

/**
 * Register or update a named hold-to-talk channel and reconcile the hook. Called
 * on startup and on every preference change for that channel.
 */
export function configureHold(id: string, config: HoldChannelConfig): void {
	const pttMode = config.pttMode && config.keycode !== null;
	const existing = channels.get(id);
	channels.set(id, {
		holding: pttMode ? (existing?.holding ?? false) : false,
		keycode: config.keycode,
		onRelease: config.onRelease,
		pttMode,
	});
	reconcileHook();
}

/**
 * Point Tab-cycling at a channel: while that channel is recording, Tab/Shift+Tab
 * fires `handler`. Only one channel owns Tab-cycling (voice input); dictation does
 * not call this.
 */
export function setTabCycle(
	id: string,
	handler: (direction: 1 | -1) => void
): void {
	tabChannelId = id;
	onTabCycle = handler;
}

/**
 * Whether a channel's hold-to-talk is actually operational: it is in push-to-talk
 * mode AND the OS key hook is running (so a release can be detected). When the hook
 * could not start — e.g. macOS Input Monitoring is not granted — this is false and
 * the caller falls back to toggle behavior so capture can never get stuck with no
 * way to stop.
 */
export function isHoldArmed(id: string): boolean {
	const channel = channels.get(id);
	return channel?.pttMode === true && hookStarted;
}

/**
 * Mark that a channel's hold-to-talk activation key was just pressed (from the
 * global shortcut, the only key-down source). Arms release detection so the next
 * matching key-up stops capture. No-op outside push-to-talk mode.
 */
export function noteHoldPressed(id: string): void {
	const channel = channels.get(id);
	if (channel?.pttMode) {
		channel.holding = true;
		reconcileHook();
	}
}

/** Mirror a channel's capture state so the hook arms only while recording. */
export function setRecording(id: string, active: boolean): void {
	if (active) {
		recordingIds.add(id);
	} else {
		recordingIds.delete(id);
	}
	reconcileHook();
}

/** Tear the hook down on app quit. */
export function stopHooks(): void {
	channels.clear();
	recordingIds.clear();
	reconcileHook();
}
