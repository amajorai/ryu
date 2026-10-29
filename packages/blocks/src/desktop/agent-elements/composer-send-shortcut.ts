export type ComposerSendShortcut = "enter" | "shift-enter" | "command-enter";

export interface ComposerKeyEvent {
	ctrlKey: boolean;
	key: string;
	metaKey: boolean;
	shiftKey: boolean;
}

export interface ComposerKeyAction {
	followUpMode?: "opposite";
	kind: "send" | "newline" | "ignore";
}

/** Key code browsers report for a keydown the IME is still processing. */
const IME_PROCESS_KEY_CODE = 229;

/**
 * Whether a keydown belongs to an active IME composition (CJK candidate
 * selection). Chromium/WebView2 set `isComposing`; WebKit (WKWebView) can
 * report the commit Enter with `isComposing === false` but keyCode 229.
 */
export function isImeComposingKeyEvent(event: {
	isComposing?: boolean;
	keyCode?: number;
}): boolean {
	return event.isComposing === true || event.keyCode === IME_PROCESS_KEY_CODE;
}

export function resolveComposerKeyAction(
	shortcut: ComposerSendShortcut,
	event: ComposerKeyEvent
): ComposerKeyAction {
	if (event.key !== "Enter") {
		return { kind: "ignore" };
	}

	if (event.shiftKey) {
		return {
			kind: shortcut === "shift-enter" ? "send" : "newline",
		};
	}

	const command = event.metaKey || event.ctrlKey;

	if (shortcut === "command-enter") {
		return {
			kind: command ? "send" : "newline",
		};
	}

	if (command) {
		return {
			kind: "send",
			followUpMode: "opposite",
		};
	}

	return {
		kind: shortcut === "enter" ? "send" : "newline",
	};
}
