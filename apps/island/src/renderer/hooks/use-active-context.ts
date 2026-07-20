// Live active-app context for the idle island pill (Island U4).
//
// When the user has granted `contextRead`, this hook gently polls Shadow's
// context bridge (via the main-process `window.island.shadow` client) for the
// active app/window and reports a small, render-friendly view:
//
//   - `appName`  the active app (or window title fallback), null when unknown
//   - `live`     true only when Shadow is reachable, capturing, and not paused
//   - `degraded` true when consent is off OR Shadow is unreachable/paused; the
//                pill then shows no live dot and a "context unavailable" tooltip
//
// The poll runs at a deliberately gentle cadence so it never competes with the
// suggestion engine's own context loop. It pauses entirely when `contextRead`
// is not granted (the main-process hard gate would reject the calls anyway).

import { useEffect, useRef, useState } from "react";
import { useConsent } from "./use-consent.ts";

/** How often the idle pill refreshes the active-app label (ms). */
const CONTEXT_POLL_MS = 5000;

/** Render-friendly snapshot of the active context for the pill. */
export interface ActiveContext {
	/** Active app name (or window-title fallback), null when unknown. */
	appName: string | null;
	/** True when consent is off or Shadow is down/paused: show no live dot. */
	degraded: boolean;
	/** True only when Shadow is reachable and actively capturing. */
	live: boolean;
}

const DEGRADED: ActiveContext = { appName: null, degraded: true, live: false };

/**
 * Poll the active context while `contextRead` consent is granted. Returns a
 * degraded snapshot (no live dot) whenever consent is off or Shadow is
 * unreachable, so the pill can fall back to the plain idle state gracefully.
 */
export function useActiveContext(): ActiveContext {
	const { consent } = useConsent();
	const contextReadAllowed = consent?.contextRead === true;
	const [context, setContext] = useState<ActiveContext>(DEGRADED);
	const activeRef = useRef(true);

	useEffect(() => {
		activeRef.current = true;

		// Consent off (or not yet answered): never touch Shadow, stay degraded.
		if (!contextReadAllowed) {
			setContext(DEGRADED);
			return () => {
				activeRef.current = false;
			};
		}

		const poll = async (): Promise<void> => {
			const result = await window.island.shadow.getCurrentContext();
			if (!activeRef.current) {
				return;
			}
			if (!result.available) {
				setContext(DEGRADED);
				return;
			}
			const { app_name, window_title, capture_active, paused } = result.context;
			const label = app_name ?? window_title ?? null;
			const capturing = capture_active && !paused;
			setContext({
				appName: label,
				live: capturing,
				degraded: !capturing,
			});
		};

		poll().catch(() => {
			if (activeRef.current) {
				setContext(DEGRADED);
			}
		});
		const timer = setInterval(() => {
			poll().catch(() => {
				if (activeRef.current) {
					setContext(DEGRADED);
				}
			});
		}, CONTEXT_POLL_MS);

		return () => {
			activeRef.current = false;
			clearInterval(timer);
		};
	}, [contextReadAllowed]);

	return context;
}
