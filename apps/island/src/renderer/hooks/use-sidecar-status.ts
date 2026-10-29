import { useCallback, useEffect, useRef, useState } from "react";

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
export function useSidecarStatus(contextReadAllowed: boolean) {
	const [state, setState] = useState({
		allowed: contextReadAllowed,
		snapshot: EMPTY,
	});
	const [starting, setStarting] = useState(false);
	const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());

	useEffect(() => {
		let alive = true;
		let pending: Promise<void> | null = null;
		let again = false;
		const publish = (snapshot: SidecarSnapshot) => {
			if (!alive) {
				return;
			}
			setState((previous) =>
				previous.allowed === contextReadAllowed &&
				previous.snapshot.coreUp === snapshot.coreUp &&
				previous.snapshot.shadowUp === snapshot.shadowUp &&
				previous.snapshot.paused === snapshot.paused &&
				previous.snapshot.recording === snapshot.recording
					? previous
					: { allowed: contextReadAllowed, snapshot }
			);
		};
		const read = async () => {
			const [health, status] = await Promise.all([
				window.island.core.health(),
				window.island.core.sidecarStatus(),
			]);
			if (!alive) {
				return;
			}
			const coreUp = health.available;
			const shadowUp =
				status.available &&
				status.sidecars.some(
					(s) => s.name === SHADOW_SIDECAR_NAME && s.running
				);
			if (!(contextReadAllowed && shadowUp)) {
				publish({ coreUp, shadowUp, recording: false, paused: false });
				return;
			}
			const [control, context] = await Promise.all([
				window.island.shadow.getCaptureControl(),
				window.island.shadow.getCurrentContext(),
			]);
			const paused = control.available && control.control.paused;
			publish({
				coreUp,
				shadowUp,
				paused,
				recording:
					control.available &&
					context.available &&
					context.context.capture_active &&
					!paused,
			});
		};
		const run = (manual = false): Promise<void> => {
			if (!alive || (!manual && document.hidden)) {
				return Promise.resolve();
			}
			if (pending) {
				if (manual) {
					again = true;
				}
				return pending;
			}
			pending = Promise.resolve()
				.then(async () => {
					do {
						again = false;
						if (!alive) {
							return;
						}
						try {
							await read();
						} catch {
							publish(EMPTY);
						}
					} while (again && alive);
				})
				.finally(() => {
					pending = null;
				});
			return pending;
		};
		refreshRef.current = () => run(true);
		const automatic = () => void run();
		automatic();
		const timer = setInterval(automatic, POLL_MS);
		document.addEventListener("visibilitychange", automatic);
		return () => {
			alive = false;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", automatic);
		};
	}, [contextReadAllowed]);
	const refresh = useCallback(() => refreshRef.current(), []);
	const startShadow = useCallback(async (): Promise<void> => {
		setStarting(true);
		try {
			await window.island.core.sidecarStart(SHADOW_SIDECAR_NAME);
			await refresh();
		} finally {
			setStarting(false);
		}
	}, [refresh]);
	// Consent changes must hide capture information before the next effect/read.
	const snapshot =
		state.allowed === contextReadAllowed ? state.snapshot : EMPTY;
	return { refresh, snapshot, startShadow, starting };
}
