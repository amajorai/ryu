import { useCallback, useEffect, useState } from "react";

/** How often the status hook re-probes Core/Shadow reachability. */
const POLL_MS = 5000;
const SHADOW_SIDECAR_NAME = "shadow";

/** Reachability + recording snapshot the expanded panel renders. */
export interface SidecarSnapshot {
	/** Core (:7980) reachable. */
	coreUp: boolean;
	/** Shadow capture is paused (incognito). */
	paused: boolean;
	/** Shadow capture active and not paused (a live recording). */
	recording: boolean;
	/** Shadow (:3030) reachable. */
	shadowUp: boolean;
}

const EMPTY: SidecarSnapshot = {
	coreUp: false,
	shadowUp: false,
	recording: false,
	paused: false,
};

/**
 * Poll Core + Shadow reachability and capture state. Shadow's *running* state is
 * read from Core's sidecar status (`GET /api/sidecar/status`) — the same source
 * the desktop uses, and consent-free, since it only reports process liveness and
 * never touches :3030 or reads any context. So the Shadow dot matches the desktop
 * even before the user grants context-read consent.
 *
 * The privacy HARD GATE still applies to *capture/recording* state: when
 * `contextReadAllowed` is false this hook makes ZERO calls to :3030, so `paused`
 * and `recording` stay false (we just don't know Shadow's capture state, and we
 * are not allowed to ask). Exposes `startShadow` and a manual `refresh`.
 */
export function useSidecarStatus(contextReadAllowed: boolean): {
	refresh: () => Promise<void>;
	snapshot: SidecarSnapshot;
	startShadow: () => Promise<void>;
	starting: boolean;
} {
	const [snapshot, setSnapshot] = useState<SidecarSnapshot>(EMPTY);
	const [starting, setStarting] = useState(false);

	const refresh = useCallback(async (): Promise<void> => {
		const [health, status] = await Promise.all([
			window.island.core.health(),
			window.island.core.sidecarStatus(),
		]);
		const coreUp = health.available;
		const shadowUp =
			status.available &&
			status.sidecars.some((s) => s.name === SHADOW_SIDECAR_NAME && s.running);

		// Capture/recording state is consent-gated: only probe :3030 when allowed.
		if (!(contextReadAllowed && shadowUp)) {
			setSnapshot({ coreUp, shadowUp, recording: false, paused: false });
			return;
		}

		const control = await window.island.shadow.getCaptureControl();
		if (control.available) {
			const { paused } = control.control;
			const context = await window.island.shadow.getCurrentContext();
			const captureActive = context.available && context.context.capture_active;
			setSnapshot({
				coreUp,
				shadowUp,
				paused,
				recording: captureActive && !paused,
			});
			return;
		}
		setSnapshot({ coreUp, shadowUp, recording: false, paused: false });
	}, [contextReadAllowed]);

	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, POLL_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	const startShadow = useCallback(async (): Promise<void> => {
		setStarting(true);
		try {
			await window.island.core.sidecarStart(SHADOW_SIDECAR_NAME);
			await refresh();
		} finally {
			setStarting(false);
		}
	}, [refresh]);

	return { refresh, snapshot, startShadow, starting };
}
