// apps/desktop/src/hooks/useCompanionContext.ts
//
// Polls Shadow :3030 for the current screen context and latest proactive
// suggestion. The hook is designed to be called on companion-overlay open so
// the pill always shows fresh data. Polling is driven by a caller-controlled
// `enabled` flag — when false (overlay hidden) no requests are made.
//
// When Shadow is unreachable both fields resolve to null and `unavailable` is
// set to true so the pill can render a graceful degraded state.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ProactiveSuggestion,
	ShadowContext,
} from "@/src/lib/api/shadow.ts";
import { getCurrentContext, getProactive } from "@/src/lib/api/shadow.ts";

export interface CompanionContextState {
	/** Current screen context snapshot, or null when Shadow is down. */
	context: ShadowContext | null;
	/** True while the first fetch of a session is in-flight. */
	loading: boolean;
	/** Latest proactive suggestion from Shadow, or null when unavailable. */
	proactive: ProactiveSuggestion | null;
	/** Trigger an immediate out-of-band refresh (e.g. on hotkey open). */
	refresh: () => void;
	/** True when Shadow :3030 was unreachable on the last fetch attempt. */
	unavailable: boolean;
}

/**
 * Poll Shadow :3030 for context and proactive suggestions.
 *
 * @param enabled - Enable polling. Pass `true` when the overlay is visible.
 * @param intervalMs - Refresh interval in milliseconds (default 5000).
 */
export function useCompanionContext(
	enabled: boolean,
	intervalMs = 5000
): CompanionContextState {
	const [context, setContext] = useState<ShadowContext | null>(null);
	const [proactive, setProactive] = useState<ProactiveSuggestion | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	const [loading, setLoading] = useState(false);

	const abortRef = useRef<AbortController | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Track first-fetch so loading is only shown before the initial response.
	const hasLoadedRef = useRef(false);

	const fetchNow = useCallback(async () => {
		abortRef.current?.abort();
		const ctrl = new AbortController();
		abortRef.current = ctrl;

		if (!hasLoadedRef.current) {
			setLoading(true);
		}

		const [ctx, proac] = await Promise.all([
			getCurrentContext(ctrl.signal),
			getProactive(ctrl.signal),
		]);

		if (ctrl.signal.aborted) {
			return;
		}

		hasLoadedRef.current = true;
		setLoading(false);
		setContext(ctx);
		setProactive(proac);
		setUnavailable(ctx === null && proac === null);
	}, []);

	// Schedule the next poll after each fetch completes.
	const scheduleNext = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
		}
		timerRef.current = setTimeout(() => {
			fetchNow().then(scheduleNext);
		}, intervalMs);
	}, [fetchNow, intervalMs]);

	useEffect(() => {
		if (!enabled) {
			abortRef.current?.abort();
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			return;
		}

		// Fetch immediately on enable, then chain polling.
		fetchNow().then(scheduleNext);

		return () => {
			abortRef.current?.abort();
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, [enabled, fetchNow, scheduleNext]);

	const refresh = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		fetchNow().then(scheduleNext);
	}, [fetchNow, scheduleNext]);

	return { context, proactive, unavailable, loading, refresh };
}
