/**
 * Pure helpers behind chat transcript keyboard scrolling and the
 * "Jump to latest" strip. The surface owns the ScrollBoxRenderable; these
 * functions only read the numbers it exposes so they stay unit-testable.
 */

import { tf } from "../i18n/translate.ts";

export type TranscriptScrollKind =
	| "pageUp"
	| "pageDown"
	| "halfUp"
	| "halfDown"
	| "top"
	| "bottom";

export interface TranscriptScrollMetrics {
	scrollHeight: number;
	scrollTop: number;
	viewportHeight: number;
}

/** Rows a page step moves: the viewport less two rows of shared context. */
export function transcriptPageStep(viewportHeight: number): number {
	return Math.max(1, viewportHeight - 2);
}

/** Rows a half-page step moves. */
export function transcriptHalfStep(viewportHeight: number): number {
	return Math.max(1, Math.floor(viewportHeight / 2));
}

/**
 * True when the reader has scrolled up far enough that new output would land
 * off screen. One row of slack matches the scrollbox's own sticky re-engage
 * point, so a sub-row rounding gap never shows the strip.
 */
export function isAwayFromBottom(metrics: TranscriptScrollMetrics): boolean {
	const maxScrollTop = Math.max(
		0,
		metrics.scrollHeight - metrics.viewportHeight
	);
	return metrics.scrollTop < maxScrollTop - 1;
}

/** What the transcript looked like when the reader scrolled away. */
export interface AwaySnapshot<T> {
	last: T | undefined;
	length: number;
}

/**
 * Counts messages that arrived or changed since the reader scrolled away:
 * every appended message, plus the message that was last at the time if it
 * has since been replaced (a streaming reply growing off screen).
 */
export function countNewSinceAway<T>(
	messages: readonly T[],
	snapshot: AwaySnapshot<T>
): number {
	const appended = Math.max(0, messages.length - snapshot.length);
	const previousLast =
		snapshot.length > 0 ? messages[snapshot.length - 1] : undefined;
	const lastChanged =
		snapshot.length > 0 &&
		snapshot.length <= messages.length &&
		previousLast !== snapshot.last;
	return appended + (lastChanged ? 1 : 0);
}

/** Text of the reserved strip shown while scrolled away from the bottom. */
export function jumpToLatestLabel(newCount: number, arrow: string): string {
	return newCount > 0
		? tf("Jump to latest {arrow} ({newCount} new) · Ctrl+End", {
				arrow,
				newCount: String(newCount),
			})
		: tf("Jump to latest {arrow} · Ctrl+End", { arrow });
}
