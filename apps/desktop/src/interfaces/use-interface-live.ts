// The push and list inputs of the interface snapshot: run-stream frames (with
// this session's own first-sighting and end-time bookkeeping), pending
// approvals, unread counts and the privacy mode. The bookkeeping is a pure
// reducer over frames, so it is unit-tested without a stream.

import { useEffect, useMemo, useRef, useState } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApprovals } from "@/src/hooks/useApprovals.ts";
import { useUserAvailability } from "@/src/hooks/useUserAvailability.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { subscribeRunFrames } from "@/src/lib/api/run-store.ts";
import type { RunStreamFrame } from "@/src/lib/api/runStream.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import type {
	InterfaceLiveInput,
	RunFrameStatus,
	TerminalSeen,
} from "./snapshot.ts";
import { useInterfacePrefs } from "./use-interface-prefs.ts";

/** Wait after a run ends before refetching the list (frames carry no preview). */
export const TERMINAL_REFRESH_DEBOUNCE_MS = 1500;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"interrupted",
]);

export interface RunLiveState {
	awaitingSince: ReadonlyMap<string, number>;
	firstSeenRunning: ReadonlyMap<string, number>;
	/** The last status this session saw per id, from any frame. */
	lastStatus: ReadonlyMap<string, string>;
	runs: ReadonlyMap<string, RunFrameStatus>;
	terminalSeen: ReadonlyMap<string, TerminalSeen>;
}

export const EMPTY_RUN_LIVE_STATE: RunLiveState = {
	awaitingSince: new Map(),
	firstSeenRunning: new Map(),
	lastStatus: new Map(),
	runs: new Map(),
	terminalSeen: new Map(),
};

/**
 * Fold one run-stream frame into the bookkeeping, at receipt time
 * `receivedAt`. The frame type matters: only a `run` delta that turns an id
 * this session saw running into completed / failed records an exact end time
 * (its `updated_at`). A snapshot frame (the opening one and every reconnect
 * replay) or an interrupted delta records the receipt time, approximate. The
 * first sighting of a run is cleared on every terminal transition and stamped
 * again on the next `running` frame, so each run gets its own start.
 */
export function reduceRunFrame(
	state: RunLiveState,
	frame: RunStreamFrame,
	receivedAt: number
): { state: RunLiveState; terminal: boolean } {
	const runs = new Map(
		frame.type === "snapshot" ? [] : [...state.runs.entries()]
	);
	const lastStatus = new Map(state.lastStatus);
	const firstSeenRunning = new Map(state.firstSeenRunning);
	const terminalSeen = new Map(state.terminalSeen);
	const awaitingSince = new Map(state.awaitingSince);
	const rows = frame.type === "snapshot" ? frame.runs : [frame.run];
	let terminal = false;
	for (const run of rows) {
		runs.set(run.id, {
			run_status: run.run_status,
			updated_at: run.updated_at,
		});
		const status = run.run_status ?? "";
		const previous = lastStatus.get(run.id);
		if (status === "running") {
			if (!firstSeenRunning.has(run.id)) {
				firstSeenRunning.set(run.id, receivedAt);
			}
			terminalSeen.delete(run.id);
		} else if (TERMINAL_STATUSES.has(status)) {
			firstSeenRunning.delete(run.id);
			if (previous === "running") {
				const exact =
					frame.type === "run" &&
					(status === "completed" || status === "failed");
				terminalSeen.set(run.id, {
					approx: !exact,
					atMs: exact ? run.updated_at : receivedAt,
					status,
					updatedAt: run.updated_at,
				});
				terminal = true;
			} else {
				// A run that started and ended out of sight (a reconnect) is not
				// the run this entry timed: drop it rather than reuse its time.
				const seen = terminalSeen.get(run.id);
				if (
					seen &&
					(seen.status !== status || seen.updatedAt !== run.updated_at)
				) {
					terminalSeen.delete(run.id);
				}
			}
		}
		if (status === "awaiting_input") {
			if (!awaitingSince.has(run.id)) {
				awaitingSince.set(run.id, receivedAt);
			}
		} else {
			awaitingSince.delete(run.id);
		}
		if (status) {
			lastStatus.set(run.id, status);
		}
	}
	return {
		state: { awaitingSince, firstSeenRunning, lastStatus, runs, terminalSeen },
		terminal,
	};
}

/** Unread counts per conversation, as the sidebar badges count them. */
export function unreadCounts(
	unreadIds: ReadonlySet<string>,
	unreadMessageCounts: ReadonlyMap<string, number>
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const id of unreadIds) {
		counts.set(id, unreadMessageCounts.get(id) ?? 1);
	}
	for (const [id, count] of unreadMessageCounts) {
		if (count > 0) {
			counts.set(id, count);
		}
	}
	return counts;
}

/** Redact when the screen may be shared or the user hid work details.
 *  Do-not-disturb does not redact: it means "don't interrupt". */
export function interfacePrivacy(
	streamingPrivacyActive: boolean,
	hideWorkDetails: boolean
): "full" | "redacted" {
	return streamingPrivacyActive || hideWorkDetails ? "redacted" : "full";
}

/** The live inputs while `enabled` (an interface is on screen). */
export function useInterfaceLive(enabled: boolean): InterfaceLiveInput {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget({ token: node.token, url: node.url, userJwt: node.userJwt }),
		[node.token, node.url, node.userJwt]
	);
	const { refresh } = useChatHistoryContext();
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	const [runState, setRunState] = useState<RunLiveState>(EMPTY_RUN_LIVE_STATE);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		let timer: ReturnType<typeof setTimeout> | null = null;
		let state = EMPTY_RUN_LIVE_STATE;
		const unsubscribe = subscribeRunFrames(target, (frame) => {
			const result = reduceRunFrame(state, frame, Date.now());
			state = result.state;
			setRunState(state);
			if (result.terminal) {
				// One coalesced list refetch per burst of finished runs.
				if (timer) {
					clearTimeout(timer);
				}
				timer = setTimeout(() => {
					timer = null;
					refreshRef.current();
				}, TERMINAL_REFRESH_DEBOUNCE_MS);
			}
		});
		return () => {
			if (timer) {
				clearTimeout(timer);
			}
			unsubscribe();
			setRunState(EMPTY_RUN_LIVE_STATE);
		};
	}, [enabled, target]);

	const { approvals } = useApprovals({ status: "pending" });
	const unreadIds = useConversationFlagsStore((state) => state.unreadIds);
	const unreadMessageCounts = useConversationFlagsStore(
		(state) => state.unreadMessageCounts
	);
	const unread = useMemo(
		() => unreadCounts(unreadIds, unreadMessageCounts),
		[unreadIds, unreadMessageCounts]
	);
	const { streamingPrivacyActive } = useUserAvailability();
	const hideWorkDetails = useInterfacePrefs((state) => state.hideWorkDetails);
	const privacy = interfacePrivacy(streamingPrivacyActive, hideWorkDetails);

	return useMemo(
		() => ({
			approvals,
			awaitingSince: runState.awaitingSince,
			firstSeenRunning: runState.firstSeenRunning,
			privacy,
			runs: runState.runs,
			terminalSeen: runState.terminalSeen,
			unread,
		}),
		[approvals, privacy, runState, unread]
	);
}
