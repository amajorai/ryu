// apps/desktop/src/hooks/useSessionBox.ts
//
// Live status of a conversation's session Box, plus the "show this Box's
// screen" request channel between the composer (CloudTaskPanel's View screen,
// the sub-agent list) and the workspace dock that hosts the screen tab.
//
// The status query asks the node's Core directly and is bounded by a timeout.
// While a Box (or a sub-agent child) is running, or the one-time cost notice
// is waiting, it polls every few seconds so the cost chip, the low-credit
// warning and the notice stay current; otherwise it polls slowly, so a Box
// that computer use starts mid-conversation still appears.
//
// A 404 (no Box) and a 403 (the rollout flag is off for this caller, or the
// Box belongs to someone else) both read as `null`: nothing to show. Any other
// failure leaves `data` undefined, which the surfaces also treat as hidden.

import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchSessionBox,
	type SessionBoxStatus,
	type SessionBoxView,
} from "@/src/lib/api/session-box.ts";

export const SESSION_BOX_QUERY_KEY = "session-box";

const LIVE_REFRESH_MS = 5000;
// Often enough that a held computer-use call's cost notice shows well inside
// Core's 90 s wait for the answer.
const IDLE_REFRESH_MS = 10_000;
const TIMEOUT_MS = 6000;
const LIVE_STATES = new Set(["provisioning", "ready"]);

/** True while a Box is provisioning or running (and so costs money). */
export function isLiveSessionBox(view: SessionBoxView | null | undefined) {
	return Boolean(view?.state && LIVE_STATES.has(view.state));
}

/** Poll fast while a Box runs or waits for the one-time cost notice. */
function anyLive(status: SessionBoxStatus | null | undefined): boolean {
	return Boolean(
		status &&
			(isLiveSessionBox(status.box) ||
				status.children.some(isLiveSessionBox) ||
				status.costNotice)
	);
}

export function useSessionBox(
	target: ApiTarget,
	conversationId: string | null | undefined,
	enabled = true
) {
	return useQuery<SessionBoxStatus | null>({
		queryKey: [
			SESSION_BOX_QUERY_KEY,
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
			conversationId ?? null,
		],
		queryFn: async ({ signal }) => {
			if (!conversationId) {
				return null;
			}
			const merged = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
			try {
				return await fetchSessionBox(target, conversationId, merged);
			} catch (error) {
				if (error instanceof ApiError && error.status === 403) {
					return null;
				}
				throw error;
			}
		},
		enabled: enabled && Boolean(conversationId),
		retry: false,
		refetchInterval: (query) =>
			anyLive(query.state.data) ? LIVE_REFRESH_MS : IDLE_REFRESH_MS,
	});
}

/** A request to show one Box's screen in the conversation's workspace dock. */
export interface SessionBoxScreenRequest {
	/** The sub-agent child number, or null for the conversation's own Box. */
	child: number | null;
	conversationId: string;
	nonce: number;
}

let latestRequest: SessionBoxScreenRequest | null = null;
let requestNonce = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function snapshot(): SessionBoxScreenRequest | null {
	return latestRequest;
}

/** Ask the dock of `conversationId` to open (or focus) its Box screen tab. */
export function openSessionBoxScreen(
	conversationId: string,
	child: number | null = null
): void {
	requestNonce += 1;
	latestRequest = { conversationId, child, nonce: requestNonce };
	for (const listener of listeners) {
		listener();
	}
}

/**
 * The newest screen request for `conversationId`, or null. Each request has a
 * fresh `nonce`, so asking for the same screen twice re-focuses its tab.
 */
export function useSessionBoxScreenRequest(
	conversationId: string | null | undefined
): SessionBoxScreenRequest | null {
	const request = useSyncExternalStore(subscribe, snapshot, snapshot);
	return request && request.conversationId === conversationId ? request : null;
}
