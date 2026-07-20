// Pure significant-change detection for the context monitor.
//
// The SuggestionEngine polls Shadow's `GET /context/current` every few seconds.
// Most polls return a near-identical snapshot, so we only fire the (expensive)
// local-model call when the context has *meaningfully* changed: a different
// foreground app, a different window title, or a large delta in the OCR text.
// Everything here is pure so it can be unit-tested without Electron, Shadow, or
// Core.

import type { ShadowContext } from "../../shared/ipc.ts";

/** The minimal slice of context that drives change detection. */
export interface ContextSnapshot {
	appName: string | null;
	/** Full text of the page the browser extension is viewing (optional bridge). */
	browserContent?: string | null;
	/** URL of the page the browser extension is viewing (optional bridge). */
	browserUrl?: string | null;
	ocrText: string | null;
	selectedText: string | null;
	windowTitle: string | null;
}

/** Why a snapshot was considered a significant change (for logging/telemetry). */
export type ChangeReason =
	| "first"
	| "app_changed"
	| "title_changed"
	| "ocr_delta"
	| "browser_changed";

/** Result of comparing a new snapshot to the previous one. */
export interface ChangeResult {
	changed: boolean;
	/** Jaccard similarity of the OCR token sets, in [0, 1]. */
	ocrSimilarity: number;
	reason: ChangeReason | null;
}

/**
 * OCR text whose token-set similarity to the previous snapshot is at or above
 * this threshold is treated as "the same screen". Below it, the screen content
 * has shifted enough to warrant a fresh suggestion.
 */
export const DEFAULT_OCR_SIMILARITY_THRESHOLD = 0.6;

const WORD_SPLIT = /\s+/;

/** Project a raw Shadow context onto the fields change detection cares about. */
export function toSnapshot(context: ShadowContext): ContextSnapshot {
	return {
		appName: context.app_name,
		windowTitle: context.window_title,
		ocrText: context.ocr_text,
		selectedText: context.selected_text,
	};
}

/** Tokenize OCR text into a lowercased set of words for similarity scoring. */
function tokenSet(text: string | null): Set<string> {
	if (!text) {
		return new Set();
	}
	const tokens = text.toLowerCase().trim().split(WORD_SPLIT);
	const set = new Set<string>();
	for (const token of tokens) {
		if (token.length > 0) {
			set.add(token);
		}
	}
	return set;
}

/**
 * Jaccard similarity (|A ∩ B| / |A ∪ B|) of two OCR token sets. Two empty texts
 * are considered identical (similarity 1); one empty and one not is 0.
 */
export function ocrSimilarity(a: string | null, b: string | null): number {
	const setA = tokenSet(a);
	const setB = tokenSet(b);
	if (setA.size === 0 && setB.size === 0) {
		return 1;
	}
	if (setA.size === 0 || setB.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) {
			intersection += 1;
		}
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 1 : intersection / union;
}

/**
 * Decide whether `next` is a significant change from `previous`. A null
 * `previous` (no prior context) is always a change with reason `first`.
 */
export function detectChange(
	previous: ContextSnapshot | null,
	next: ContextSnapshot,
	similarityThreshold: number = DEFAULT_OCR_SIMILARITY_THRESHOLD
): ChangeResult {
	if (!previous) {
		return { changed: true, reason: "first", ocrSimilarity: 0 };
	}
	const similarity = ocrSimilarity(previous.ocrText, next.ocrText);
	if (previous.appName !== next.appName) {
		return { changed: true, reason: "app_changed", ocrSimilarity: similarity };
	}
	if (previous.windowTitle !== next.windowTitle) {
		return {
			changed: true,
			reason: "title_changed",
			ocrSimilarity: similarity,
		};
	}
	// A new browser page (different URL) is a meaningful change even when the
	// on-screen OCR looks similar (e.g. two pages with the same chrome).
	if ((previous.browserUrl ?? null) !== (next.browserUrl ?? null)) {
		return {
			changed: true,
			reason: "browser_changed",
			ocrSimilarity: similarity,
		};
	}
	if (similarity < similarityThreshold) {
		return { changed: true, reason: "ocr_delta", ocrSimilarity: similarity };
	}
	return { changed: false, reason: null, ocrSimilarity: similarity };
}
