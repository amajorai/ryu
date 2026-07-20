// Suggestion queueing + lifecycle for the island chip (Island U4).
//
// Subscribes to the U3 engine's `suggestion:new` / `suggestion:cleared` IPC
// events and drives the island's `suggestion` state. Responsibilities:
//
//   - ONE suggestion at a time. A newer `suggestion:new` while one is showing
//     is queued (single slot, newest wins) and surfaced only after the current
//     one is resolved (accepted/dismissed/snoozed/expired).
//   - Accept   -> openChatWithPrefill(body || title) (morph to expanded; U5
//                 consumes the prefill) and post thumbs_up feedback.
//   - Dismiss  -> post `dismiss` feedback, collapse to idle.
//   - Snooze   -> post `snooze` feedback, collapse to idle.
//   - Auto-collapse after ~20s, recorded as a `dismiss` so the engine's history
//     (dedupe + cooldown) treats it as resolved and never re-shows it.
//   - `suggestion:cleared` (engine stopped / consent revoked) drops the active
//     and queued suggestions and collapses.
//
// Feedback always routes through `window.island.suggestions.feedback`, which
// the main process forwards to Shadow `POST /api/feedback`.

import { useCallback, useEffect, useRef, useState } from "react";
import type { IslandSuggestion } from "../../shared/ipc.ts";
import { useIslandState } from "../store/island-state.ts";

/** How long a suggestion chip stays up before auto-collapsing (ms). */
export const SUGGESTION_AUTO_COLLAPSE_MS = 20_000;

/** What the renderer can do with the surfaced suggestion. */
export interface SuggestionQueue {
	/** Accept -> open chat prefilled + thumbs_up feedback. */
	accept: () => void;
	/** The suggestion currently shown, or null when none. */
	active: IslandSuggestion | null;
	/** Dismiss -> collapse + dismiss feedback. */
	dismiss: () => void;
	/** Snooze -> collapse + snooze feedback. */
	snooze: () => void;
}

function prefillText(suggestion: IslandSuggestion): string {
	const body = suggestion.body.trim();
	return body.length > 0 ? body : suggestion.title;
}

/**
 * Wire the suggestion engine's events into a single-slot queue and drive the
 * island state. Returns the active suggestion plus the three resolution actions.
 */
export function useSuggestionQueue(): SuggestionQueue {
	const state = useIslandState((store) => store.state);
	const setState = useIslandState((store) => store.setState);
	const openChatWithPrefill = useIslandState(
		(store) => store.openChatWithPrefill
	);

	const [active, setActive] = useState<IslandSuggestion | null>(null);
	const queuedRef = useRef<IslandSuggestion | null>(null);
	const activeRef = useRef<IslandSuggestion | null>(null);
	const stateRef = useRef(state);
	stateRef.current = state;

	// Send feedback for a suggestion id, swallowing transport errors (the user's
	// intent is recorded locally even when Shadow is offline).
	const sendFeedback = useCallback(
		(id: string, kind: "thumbs_up" | "dismiss" | "snooze"): void => {
			window.island.suggestions.feedback({ id, kind }).catch(() => undefined);
		},
		[]
	);

	// Promote a queued suggestion (if any) to active, or clear to idle.
	const advance = useCallback((): void => {
		const next = queuedRef.current;
		queuedRef.current = null;
		if (next) {
			activeRef.current = next;
			setActive(next);
			setState("suggestion");
			return;
		}
		activeRef.current = null;
		setActive(null);
		// Only collapse if we are still on the suggestion surface: never yank the
		// user out of an expanded chat they accepted into. Fold back to the
		// resting logo circle; the user taps it to split the text pill out again.
		if (stateRef.current === "suggestion") {
			setState("collapsed");
		}
	}, [setState]);

	const resolve = useCallback(
		(kind: "thumbs_up" | "dismiss" | "snooze"): void => {
			const current = activeRef.current;
			if (!current) {
				return;
			}
			sendFeedback(current.id, kind);
			if (kind === "thumbs_up") {
				openChatWithPrefill(prefillText(current));
				activeRef.current = null;
				setActive(null);
				// A newly queued suggestion waits until the chat is dismissed; it is
				// not surfaced over the expanded panel. Keep it queued for later.
				return;
			}
			advance();
		},
		[advance, openChatWithPrefill, sendFeedback]
	);

	const accept = useCallback(() => resolve("thumbs_up"), [resolve]);
	const dismiss = useCallback(() => resolve("dismiss"), [resolve]);
	const snooze = useCallback(() => resolve("snooze"), [resolve]);

	// Subscribe to engine events. New suggestions either become active (when the
	// island is free) or queue behind the current one.
	useEffect(() => {
		const onNew = (suggestion: IslandSuggestion): void => {
			if (activeRef.current || stateRef.current === "expanded") {
				// Single-slot queue: newest wins.
				queuedRef.current = suggestion;
				return;
			}
			activeRef.current = suggestion;
			setActive(suggestion);
			setState("suggestion");
		};
		const onCleared = (): void => {
			queuedRef.current = null;
			activeRef.current = null;
			setActive(null);
			if (stateRef.current === "suggestion") {
				setState("collapsed");
			}
		};
		const unsubNew = window.island.suggestions.onNew(onNew);
		const unsubCleared = window.island.suggestions.onCleared(onCleared);
		return () => {
			unsubNew();
			unsubCleared();
		};
	}, [setState]);

	// Auto-collapse the active suggestion after the timeout, recorded as a
	// dismiss so the engine treats it as resolved (history, not re-shown).
	useEffect(() => {
		if (!active) {
			return;
		}
		const timer = setTimeout(() => {
			const current = activeRef.current;
			if (current && current.id === active.id) {
				sendFeedback(current.id, "dismiss");
				advance();
			}
		}, SUGGESTION_AUTO_COLLAPSE_MS);
		return () => clearTimeout(timer);
	}, [active, advance, sendFeedback]);

	return { active, accept, dismiss, snooze };
}
