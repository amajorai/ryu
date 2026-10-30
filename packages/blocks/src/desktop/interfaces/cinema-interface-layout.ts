import type { CinemaRect } from "./cinema-preview.tsx";

/** How long the pointer rests on a poster before its preview grows. */
export const PREVIEW_DELAY = 450;
/** Grace period for the pointer to travel from a poster onto its preview. */
export const PREVIEW_GRACE = 90;
/** Below this the thread panel covers the catalogue instead of sitting beside it. */
export const PANEL_SPLIT_MIN_WIDTH = 900;
/** Below this the nav folds its links into Browse. */
export const NAV_COMPACT_MAX_WIDTH = 760;
/** Below this the billboard switches to its phone layout. */
export const BILLBOARD_COMPACT_MAX_WIDTH = 640;
export const RELATED_LIMIT = 6;

export const COLLECTION_EMPTY: Record<string, string> = {
	attention: "Nothing needs attention. Every run finished cleanly.",
	continue: "You're all caught up. Threads land here when an agent replies.",
	list: "Pin a thread and it shows up here.",
	live: "No agent is working right now.",
};

export function panelWidthFor(width: number): number {
	if (width >= 1280) {
		return 480;
	}
	if (width >= 1100) {
		return 440;
	}
	return 400;
}

export function billboardHeightFor(width: number, frameHeight: number): number {
	if (width < BILLBOARD_COMPACT_MAX_WIDTH) {
		return Math.round(
			Math.min(Math.max(width * 1.1, 440), Math.max(440, frameHeight * 0.86))
		);
	}
	return Math.round(Math.min(width * 0.5625, Math.max(440, frameHeight * 0.8)));
}

export interface PreviewState {
	rect: CinemaRect;
	threadId: string;
}
