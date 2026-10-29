import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	CHAT_RECOVERY_STOP_EVENT,
	CHAT_RETRY_STARTED_EVENT,
	CHAT_TURN_STARTED_EVENT,
	fetchRuns,
	loadRetryCandidates,
	loadStoppedConversations,
	mergeOutageCandidates,
	normalizeStoppedConversations,
	reconnectRetryStorageKey,
	retryConversation,
	saveRetryCandidates,
	saveStoppedConversations,
	selectPendingRetries,
} from "@/src/lib/reconnect-retry.ts";
import type { RunSummary } from "./useRuns.ts";

export type ReconnectRetryPhase =
	| "idle"
	| "offline"
	| "retrying"
	| "complete"
	| "error";

export interface ReconnectRetryState {
	candidateCount: number;
	failedCount: number;
	phase: ReconnectRetryPhase;
	retriedCount: number;
}

export const EMPTY_RECONNECT_RETRY_STATE: ReconnectRetryState = {
	candidateCount: 0,
	failedCount: 0,
	phase: "idle",
	retriedCount: 0,
};

const TRANSIENT_STATUS_MS = 6000;
const RECONNECT_RETRY_PROBE_MS = 2000;

function browserIsOnline(): boolean {
	return !globalThis.navigator || navigator.onLine;
}

const recoveryEventSchema = z.object({
	detail: z.object({ conversationId: z.string(), nodeUrl: z.string() }),
});

function recoveryConversationId(event: Event, nodeUrl: string): string | null {
	const parsed = recoveryEventSchema.safeParse(event);
	return parsed.success && parsed.data.detail.nodeUrl === nodeUrl
		? parsed.data.detail.conversationId
		: null;
}

/** Shared production lifecycle; the browser proof supplies a controlled node. */
export function useReconnectRetryRecovery({
	activeNode,
	activeNodeOnline,
	devRecovery,
	pluginEnabled,
	probeActiveNode,
	runs,
}: {
	activeNode: ApiTarget;
	activeNodeOnline: boolean | null;
	devRecovery: boolean;
	pluginEnabled: boolean;
	probeActiveNode: () => Promise<boolean | undefined>;
	runs: readonly Pick<RunSummary, "id" | "run_status">[];
}): ReconnectRetryState {
	const enabled = devRecovery || pluginEnabled;
	const [browserOnline, setBrowserOnline] = useState(browserIsOnline);
	const [state, setState] = useState<ReconnectRetryState>(
		EMPTY_RECONNECT_RETRY_STATE
	);
	const outageActive = useRef(false);
	const retryInFlight = useRef(new Set<string>());
	const transientTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconciledNode = useRef<string | null>(null);
	const startupSnapshotAttempts = useRef(new Map<string, number>());
	const currentNode = useRef(activeNode.url);
	const stoppedTurns = useRef(new Map<string, Map<string, number>>());
	const memoryOnlyStops = useRef(new Set<string>());
	const previousRuns = useRef(runs);
	currentNode.current = activeNode.url;

	const storageKey = useMemo(
		() => reconnectRetryStorageKey(activeNode.url),
		[activeNode.url]
	);
	const readStopped = useCallback(() => {
		const stored = loadStoppedConversations(storageKey);
		const previous =
			stoppedTurns.current.get(storageKey) ?? new Map<string, number>();
		const records =
			stored === null || memoryOnlyStops.current.has(storageKey)
				? [...previous].map(([conversationId, capturedAt]) => ({
						conversationId,
						capturedAt,
					}))
				: stored;
		const stopped = new Map(
			normalizeStoppedConversations(records).map((record) => [
				record.conversationId,
				record.capturedAt,
			])
		);
		stoppedTurns.current.set(storageKey, stopped);
		return stopped;
	}, [storageKey]);
	const writeStopped = useCallback(
		(stopped: ReadonlyMap<string, number>) => {
			const saved = saveStoppedConversations(
				storageKey,
				[...stopped].map(([conversationId, capturedAt]) => ({
					conversationId,
					capturedAt,
				}))
			);
			if (saved) {
				memoryOnlyStops.current.delete(storageKey);
			} else {
				memoryOnlyStops.current.add(storageKey);
			}
		},
		[storageKey]
	);

	const showTransient = useCallback((next: ReconnectRetryState) => {
		setState(next);
		if (transientTimer.current) {
			clearTimeout(transientTimer.current);
		}
		transientTimer.current = setTimeout(() => {
			setState(EMPTY_RECONNECT_RETRY_STATE);
			transientTimer.current = null;
		}, TRANSIENT_STATUS_MS);
	}, []);

	const captureOutage = useCallback(() => {
		const stopped = readStopped();
		const queued = mergeOutageCandidates(
			loadRetryCandidates(storageKey),
			runs.filter((run) => !stopped.has(run.id))
		);
		saveRetryCandidates(storageKey, queued);
		outageActive.current = true;
		if (queued.length > 0) {
			setState({
				candidateCount: queued.length,
				failedCount: 0,
				phase: "offline",
				retriedCount: 0,
			});
		}
	}, [readStopped, runs, storageKey]);

	const retryPending = useCallback(
		async (initialRecovery = false) => {
			if (retryInFlight.current.has(storageKey)) {
				return;
			}
			const candidates = loadRetryCandidates(storageKey);
			if (candidates.length === 0) {
				if (initialRecovery) {
					reconciledNode.current = storageKey;
				}
				return;
			}
			if (initialRecovery) {
				const attempts = startupSnapshotAttempts.current.get(storageKey) ?? 0;
				if (attempts >= 3) {
					return;
				}
				startupSnapshotAttempts.current.set(storageKey, attempts + 1);
			}
			retryInFlight.current.add(storageKey);
			const target = {
				token: activeNode.token ?? null,
				userJwt: activeNode.userJwt ?? null,
				url: activeNode.url,
			};
			try {
				const currentRuns = await fetchRuns(target);
				const stopped = readStopped();
				const blockedIds = new Set(stopped.keys());
				let clearedStop = false;
				for (const run of currentRuns) {
					if (run.run_status !== "running" && stopped.delete(run.id)) {
						clearedStop = true;
					}
				}
				if (clearedStop) {
					writeStopped(stopped);
				}
				const selection = selectPendingRetries(
					loadRetryCandidates(storageKey).filter(
						(candidate) => !blockedIds.has(candidate.conversationId)
					),
					currentRuns
				);
				if (currentNode.current !== target.url) {
					return;
				}
				if (initialRecovery) {
					reconciledNode.current = storageKey;
				}
				// Claim the attempt durably before POST. Reloading during the request
				// must not submit the same interrupted turn a second time.
				const retained = devRecovery
					? selection.retained.map((candidate) => ({
							...candidate,
							attempts: 0,
						}))
					: selection.retained;
				saveRetryCandidates(storageKey, [...retained, ...selection.retry]);
				if (selection.retry.length === 0) {
					return;
				}

				setState({
					candidateCount: selection.retry.length,
					failedCount: 0,
					phase: "retrying",
					retriedCount: 0,
				});
				const results = await Promise.allSettled(
					selection.retry.map((candidate) =>
						retryConversation(target, candidate.conversationId)
					)
				);
				if (currentNode.current !== target.url) {
					return;
				}
				let retriedCount = 0;
				let failedCount = 0;
				for (const [index, result] of results.entries()) {
					if (result.status === "fulfilled") {
						if (!devRecovery) {
							saveRetryCandidates(
								storageKey,
								loadRetryCandidates(storageKey).filter(
									(candidate) =>
										candidate.conversationId !==
										selection.retry[index].conversationId
								)
							);
						}
						retriedCount += 1;
						if (globalThis.window) {
							window.dispatchEvent(
								new CustomEvent(CHAT_RETRY_STARTED_EVENT, {
									detail: {
										conversationId: selection.retry[index].conversationId,
										source: "reconnect-retry",
									},
								})
							);
						}
					} else {
						failedCount += 1;
					}
				}
				showTransient({
					candidateCount: selection.retry.length,
					failedCount,
					phase: failedCount === 0 ? "complete" : "error",
					retriedCount,
				});
			} catch {
				// Keep the candidate for the next genuine outage transition. A node
				// that answered one probe can still reject the first request while its
				// HTTP listener is warming up.
				// A failed read leaves storage unchanged; a failed POST keeps its
				// already-claimed attempt rather than resetting the retry budget.
				showTransient({
					candidateCount: candidates.length,
					failedCount: candidates.length,
					phase: "error",
					retriedCount: 0,
				});
			} finally {
				retryInFlight.current.delete(storageKey);
			}
		},
		[
			activeNode,
			devRecovery,
			readStopped,
			showTransient,
			storageKey,
			writeStopped,
		]
	);

	useEffect(() => {
		if (!(enabled && devRecovery) || activeNodeOnline !== true) {
			return;
		}
		if (reconciledNode.current === storageKey) {
			return;
		}
		void retryPending(true);
	}, [activeNodeOnline, devRecovery, enabled, retryPending, storageKey]);

	useEffect(() => {
		if (!(enabled && globalThis.window)) {
			return;
		}
		let freshSnapshot = previousRuns.current !== runs;
		previousRuns.current = runs;
		const captureRunning = () => {
			const stopped = readStopped();
			const confirmedRunning = freshSnapshot;
			freshSnapshot = false;
			// Only running turns are captured. Existing outage records survive
			// until a fresh server snapshot decides whether they may restart.
			let clearedStop = false;
			for (const run of runs) {
				if (run.run_status !== "running" && stopped.delete(run.id)) {
					clearedStop = true;
				}
			}
			if (clearedStop) {
				writeStopped(stopped);
			}
			if (!devRecovery) {
				return;
			}
			const queued = mergeOutageCandidates(
				loadRetryCandidates(storageKey),
				runs.filter((run) => !stopped.has(run.id))
			);
			const terminalIds = new Set(
				runs
					.filter(
						(run) =>
							run.run_status === "completed" ||
							run.run_status === "cancelled" ||
							run.run_status === "stopped"
					)
					.map((run) => run.id)
			);
			const runningIds = new Set(
				runs.filter((run) => run.run_status === "running").map((run) => run.id)
			);
			saveRetryCandidates(
				storageKey,
				queued
					.filter((candidate) => !terminalIds.has(candidate.conversationId))
					.map((candidate) =>
						runningIds.has(candidate.conversationId)
							? {
									...candidate,
									capturedAt: Date.now(),
									attempts: confirmedRunning ? 0 : candidate.attempts,
								}
							: candidate
					)
			);
		};
		captureRunning();
		if (!devRecovery) {
			return;
		}
		window.addEventListener("pagehide", captureRunning);
		const checkpoint =
			activeNodeOnline === true
				? window.setInterval(captureRunning, 30_000)
				: null;
		return () => {
			window.removeEventListener("pagehide", captureRunning);
			if (checkpoint !== null) {
				window.clearInterval(checkpoint);
			}
		};
	}, [
		activeNodeOnline,
		devRecovery,
		enabled,
		readStopped,
		runs,
		storageKey,
		writeStopped,
	]);

	useEffect(() => {
		if (!(enabled && globalThis.window)) {
			return;
		}
		readStopped();
		const onStop = (event: Event) => {
			const conversationId = recoveryConversationId(event, activeNode.url);
			if (conversationId === null) {
				return;
			}
			const stopped = readStopped();
			stopped.set(conversationId, Date.now());
			writeStopped(stopped);
			saveRetryCandidates(
				storageKey,
				loadRetryCandidates(storageKey).filter(
					(candidate) => candidate.conversationId !== conversationId
				)
			);
		};
		const onStarted = (event: Event) => {
			const conversationId = recoveryConversationId(event, activeNode.url);
			if (conversationId === null) {
				return;
			}
			const stopped = readStopped();
			stopped.delete(conversationId);
			writeStopped(stopped);
			const candidates = loadRetryCandidates(storageKey).filter(
				(candidate) => candidate.conversationId !== conversationId
			);
			if (devRecovery) {
				candidates.push({
					conversationId,
					capturedAt: Date.now(),
					attempts: 0,
				});
			}
			saveRetryCandidates(storageKey, candidates);
		};
		window.addEventListener(CHAT_RECOVERY_STOP_EVENT, onStop);
		window.addEventListener(CHAT_TURN_STARTED_EVENT, onStarted);
		return () => {
			window.removeEventListener(CHAT_RECOVERY_STOP_EVENT, onStop);
			window.removeEventListener(CHAT_TURN_STARTED_EVENT, onStarted);
		};
	}, [
		activeNode.url,
		devRecovery,
		enabled,
		readStopped,
		storageKey,
		writeStopped,
	]);

	useEffect(() => {
		if (!(enabled && globalThis.window)) {
			return;
		}
		const onOnline = () => {
			setBrowserOnline(true);
			probeActiveNode().catch(() => undefined);
		};
		const onOffline = () => setBrowserOnline(false);
		window.addEventListener("online", onOnline);
		window.addEventListener("offline", onOffline);
		return () => {
			window.removeEventListener("online", onOnline);
			window.removeEventListener("offline", onOffline);
		};
	}, [enabled, probeActiveNode]);

	useEffect(() => {
		if (!(enabled && globalThis.window)) {
			return;
		}
		const timer = window.setInterval(() => {
			if (
				devRecovery &&
				activeNodeOnline === true &&
				reconciledNode.current !== storageKey
			) {
				void retryPending(true);
			}
			if (outageActive.current) {
				probeActiveNode().catch(() => undefined);
			}
		}, RECONNECT_RETRY_PROBE_MS);
		return () => window.clearInterval(timer);
	}, [
		activeNodeOnline,
		devRecovery,
		enabled,
		probeActiveNode,
		retryPending,
		storageKey,
	]);

	useEffect(() => {
		if (!enabled) {
			outageActive.current = false;
			setState(EMPTY_RECONNECT_RETRY_STATE);
			return;
		}
		const connectionDown = !browserOnline || activeNodeOnline === false;
		if (connectionDown) {
			captureOutage();
			return;
		}
		if (!outageActive.current) {
			return;
		}
		outageActive.current = false;
		void retryPending();
	}, [activeNodeOnline, browserOnline, captureOutage, enabled, retryPending]);

	useEffect(
		() => () => {
			if (transientTimer.current) {
				clearTimeout(transientTimer.current);
			}
		},
		[]
	);

	return enabled ? state : EMPTY_RECONNECT_RETRY_STATE;
}
