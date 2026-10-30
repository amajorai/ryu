// The floating (auto-demoted) pinned summary is an on-demand sheet.
//
// When the window is too narrow to dock the pinned summary next to the chat,
// WorkspacePanels mounts it as a floating overlay above the transcript. That
// overlay must not appear on its own (on first load, after the first message,
// or when a window is narrowed); it opens only when the person asks for it from
// the titlebar toggle or the overflow menu. The toggles record the request here,
// and the floating panel dismisses itself on mount unless a request is recent.
//
// A timestamp rather than a consumed flag: React StrictMode mounts effects
// twice in development, and a consumed flag would read "not requested" on the
// second pass. The short window keeps a stale request from a docked open from
// leaking into a later floating mount.

const OPEN_REQUEST_WINDOW_MS = 1000;
let lastOpenRequestAt = Number.NEGATIVE_INFINITY;

/** Call from a pinned-summary toggle before it flips the open state. */
export function notePinnedSummaryToggle(currentlyOpen: boolean): void {
	if (!currentlyOpen) {
		lastOpenRequestAt = Date.now();
	}
}

/** Whether the person asked to open the pinned summary just now. */
export function pinnedSummaryOpenWasRequested(): boolean {
	return Date.now() - lastOpenRequestAt < OPEN_REQUEST_WINDOW_MS;
}
