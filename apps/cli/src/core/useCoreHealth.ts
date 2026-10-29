// Shared Core reachability for the shell. One poller (mounted by
// CoreHealthProvider) checks GET /api/health once per active node; only while that
// node is down does it keep polling, starting at 3s and backing off to 10s, so a
// healthy session adds no background traffic. Surfaces that see a request fail can
// call recheck() to refresh it early instead of waiting for the next tick.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { healthCheck } from "./nodes.ts";

export type CoreHealthState = "unknown" | "up" | "down";

export interface CoreHealth {
	/** Epoch ms of the last completed check, or null before the first one. */
	lastChecked: number | null;
	/** Epoch ms of the next scheduled re-check while down, else null. */
	nextRetryAt: number | null;
	/** Check now, cancelling any scheduled retry. */
	recheck: () => void;
	state: CoreHealthState;
	/** The node URL this state describes (so callers can ignore a stale node). */
	url: string;
}

/** Retry delays while Core is down: 3s, 5s, 8s, then every 10s. */
export const HEALTH_RETRY_DELAYS_MS = [3000, 5000, 8000, 10_000] as const;

/** Delay before retry number `attempt` (0-based), capped at the last step. */
export function healthRetryDelay(attempt: number): number {
	const last = HEALTH_RETRY_DELAYS_MS.length - 1;
	return HEALTH_RETRY_DELAYS_MS[Math.min(Math.max(0, attempt), last)] ?? 10_000;
}

interface Snapshot {
	lastChecked: number | null;
	nextRetryAt: number | null;
	state: CoreHealthState;
	url: string;
}

/** Poll the active node's health; see the module comment for the cadence. */
export function useCoreHealthPoller(
	target: ApiTarget,
	check: (target: ApiTarget) => Promise<boolean> = healthCheck
): CoreHealth {
	const [snapshot, setSnapshot] = useState<Snapshot>({
		state: "unknown",
		lastChecked: null,
		nextRetryAt: null,
		url: target.url,
	});
	const targetRef = useRef(target);
	targetRef.current = target;
	const checkRef = useRef(check);
	checkRef.current = check;
	const requestRef = useRef(0);
	const attemptRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearTimer = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const runCheck = useCallback(() => {
		clearTimer();
		const requestId = ++requestRef.current;
		const current = targetRef.current;
		checkRef
			.current(current)
			.catch(() => false)
			.then((ok) => {
				if (requestRef.current !== requestId) {
					return;
				}
				const now = Date.now();
				if (ok) {
					attemptRef.current = 0;
					setSnapshot({
						state: "up",
						lastChecked: now,
						nextRetryAt: null,
						url: current.url,
					});
					return;
				}
				const delay = healthRetryDelay(attemptRef.current);
				attemptRef.current += 1;
				setSnapshot({
					state: "down",
					lastChecked: now,
					nextRetryAt: now + delay,
					url: current.url,
				});
				timerRef.current = setTimeout(runCheck, delay);
			});
	}, [clearTimer]);

	// One check per node (url/token); a new node starts from "unknown".
	useEffect(() => {
		attemptRef.current = 0;
		setSnapshot({
			state: "unknown",
			lastChecked: null,
			nextRetryAt: null,
			url: target.url,
		});
		runCheck();
		return () => {
			requestRef.current += 1;
			clearTimer();
		};
	}, [target.url, target.token, runCheck, clearTimer]);

	const recheck = useCallback(() => {
		attemptRef.current = 0;
		runCheck();
	}, [runCheck]);

	return useMemo(() => ({ ...snapshot, recheck }), [snapshot, recheck]);
}
