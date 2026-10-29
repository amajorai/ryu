// apps/desktop/src/hooks/useAgentUiStateHost.ts
//
// The desktop implementation of the generative-UI state host (see
// `@ryu/blocks/.../agent-ui/state-host-context.tsx`): one bulk read of every saved
// widget state for the open conversation, and a best-effort save per widget.
//
// Saved state lives in a mutable map rather than React state. A widget reads it
// when it mounts, and local writes update the map without re-rendering, so typing
// into a widget never remounts it. Only a server read that changes what a widget
// would show bumps `version`.
//
// The read is refreshed each time the conversation is opened, so edits a
// collaborator saved in the meantime show up then. Everyone who can write the
// conversation shares one record per widget and the last save wins; a widget
// whose local copy may be newer than a read (a save that was unanswered, started
// or settled after the read was requested) keeps it.
//
// The map only holds what Core accepted or is about to: a record Core would
// refuse is never stored, and a failed save falls back to the previous copy.

import type {
	AgentUiSavedState,
	AgentUiStateHost,
} from "@ryu/blocks/desktop/agent-elements/agent-ui/state-host-context.tsx";
import {
	AGENT_UI_STATE_MAX_BYTES,
	AGENT_UI_STATE_MAX_DEPTH,
	agentUiStateLimitProblem,
} from "@ryu/blocks/desktop/agent-elements/agent-ui/state-limits.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	mergeServerRead,
	type SavedStates,
} from "@/src/lib/agent-ui-state-merge.ts";
import {
	listAgentUiStates,
	saveAgentUiState,
} from "@/src/lib/api/agent-ui-state.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** Why Core would refuse a record (see state-limits.ts), or `null`. */
function unsavableReason(saved: AgentUiSavedState): string | null {
	const problem = agentUiStateLimitProblem(saved);
	if (problem === "size") {
		return `it is larger than ${AGENT_UI_STATE_MAX_BYTES} bytes of JSON`;
	}
	if (problem === "depth") {
		return `it nests deeper than ${AGENT_UI_STATE_MAX_DEPTH} levels`;
	}
	return null;
}

function warnUnsaved(toolCallId: string, reason: string): void {
	if (import.meta.env.DEV) {
		console.warn(`[agent-ui] state for ${toolCallId} was not saved:`, reason);
	}
}

// Which local edits a server read must not override. Module-level so every host
// for the same conversation (the chat page and the assistant panel) agrees. One
// clock ticks when a read is requested and when a save starts or settles. A
// widget whose save started or settled after the read was requested may be
// missing from that read (Core can answer the read before it applies the save),
// so its local copy wins.
let activityClock = 0;
const localWrites = new Map<
	string,
	{ inFlight: number; lastActivity: number }
>();
const readStartedAt = new WeakMap<SavedStates, number>();

function tick(): number {
	activityClock += 1;
	return activityClock;
}

function writeKey(conversationId: string, toolCallId: string): string {
	return `${conversationId}\u0000${toolCallId}`;
}

function localCopyIsNewer(key: string, readStart: number): boolean {
	const write = localWrites.get(key);
	return (
		write !== undefined &&
		(write.inFlight > 0 || write.lastActivity > readStart)
	);
}

/**
 * Persistence for `ui.render` widgets in one conversation. `null` (no host, so
 * widgets keep state in memory) for a temporary chat or before a conversation
 * exists, since there is nothing durable to attach state to.
 */
export function useAgentUiStateHost(
	conversationId: string | null
): AgentUiStateHost | null {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => ["agent-ui-state", node.url, conversationId],
		[node.url, conversationId]
	);
	// The map belongs to one conversation; switching chats starts a fresh one.
	const savedRef = useRef<{
		conversationId: string | null;
		states: SavedStates;
	}>({ conversationId, states: new Map() });
	if (savedRef.current.conversationId !== conversationId) {
		// Start from the cached read, which already includes this session's edits.
		savedRef.current = {
			conversationId,
			states: new Map(queryClient.getQueryData<SavedStates>(queryKey)),
		};
	}
	const [version, setVersion] = useState(0);
	// The last map this hook put into the query cache itself. Seeing it come back
	// as `query.data` is our own write, not a server read, so it must not remount.
	const ownCacheWriteRef = useRef<SavedStates | null>(null);

	const query = useQuery({
		queryKey,
		queryFn: async (): Promise<SavedStates> => {
			if (!conversationId) {
				return new Map();
			}
			const startedAt = tick();
			const states = await listAgentUiStates(target, conversationId);
			readStartedAt.set(states, startedAt);
			return states;
		},
		enabled: Boolean(conversationId),
		// Re-read whenever the conversation is opened (mount or switch) so a
		// collaborator's edits appear. Not on focus or reconnect: a refetch while
		// the user is typing would remount the widget under them.
		staleTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});

	useEffect(() => {
		const data = query.data;
		if (!(data && conversationId) || data === ownCacheWriteRef.current) {
			return;
		}
		// A map that is not a server read was cached by another host for this
		// conversation; it already holds every local edit, so take it as it is.
		const readStart = readStartedAt.get(data);
		const merged = mergeServerRead(
			savedRef.current.states,
			data,
			(toolCallId) =>
				readStart !== undefined &&
				localCopyIsNewer(writeKey(conversationId, toolCallId), readStart)
		);
		if (merged.keptLocal) {
			// Keep the cached read in step, so reopening this chat (or another
			// host) does not fall back to the older server copy.
			const cached = new Map(merged.states);
			ownCacheWriteRef.current = cached;
			queryClient.setQueryData<SavedStates>(queryKey, cached);
		}
		if (merged.changed) {
			savedRef.current = { conversationId, states: merged.states };
			setVersion((current) => current + 1);
		}
	}, [conversationId, query.data, queryClient, queryKey]);

	return useMemo<AgentUiStateHost | null>(() => {
		if (!conversationId) {
			return null;
		}
		// Point one widget's entry at `next` (or drop it) in both the map and the
		// cached read, so returning to this chat later restores the same copy. With
		// `onlyIf`, change it only where it still holds that exact record.
		const replace = (
			toolCallId: string,
			next: AgentUiSavedState | undefined,
			onlyIf?: AgentUiSavedState
		) => {
			const { current } = savedRef;
			if (
				current.conversationId === conversationId &&
				(onlyIf === undefined || current.states.get(toolCallId) === onlyIf)
			) {
				if (next) {
					current.states.set(toolCallId, next);
				} else {
					current.states.delete(toolCallId);
				}
			}
			queryClient.setQueryData<SavedStates>(queryKey, (cached) => {
				if (onlyIf !== undefined && cached?.get(toolCallId) !== onlyIf) {
					return cached;
				}
				const updated = new Map(cached);
				if (next) {
					updated.set(toolCallId, next);
				} else {
					updated.delete(toolCallId);
				}
				ownCacheWriteRef.current = updated;
				return updated;
			});
		};
		return {
			version,
			read: (toolCallId) => savedRef.current.states.get(toolCallId),
			write: (toolCallId, incoming) => {
				const previous = savedRef.current.states.get(toolCallId);
				// A widget that draws its title outside the record (a turn-end card's
				// header) keeps the title an earlier save stored.
				const saved =
					incoming.title === undefined && previous?.title !== undefined
						? { ...incoming, title: previous.title }
						: incoming;
				const reason = unsavableReason(saved);
				if (reason) {
					// Core would answer 400 every time, so keep the last saved copy
					// rather than show state that can never be saved.
					warnUnsaved(toolCallId, reason);
					return;
				}
				replace(toolCallId, saved);
				const key = writeKey(conversationId, toolCallId);
				// One entry per widget, updated in place, so every save's settle
				// decrements the same counter.
				const write = localWrites.get(key) ?? { inFlight: 0, lastActivity: 0 };
				write.inFlight += 1;
				write.lastActivity = tick();
				localWrites.set(key, write);
				saveAgentUiState(target, conversationId, toolCallId, saved)
					.catch((error: unknown) => {
						// Not saved. Unless a newer edit already replaced it, fall back to
						// the previous copy so a remount shows what Core holds; the next
						// edit saves the whole record again.
						replace(toolCallId, previous, saved);
						warnUnsaved(
							toolCallId,
							error instanceof Error ? error.message : String(error)
						);
					})
					.finally(() => {
						write.inFlight = Math.max(0, write.inFlight - 1);
						write.lastActivity = tick();
					});
			},
		};
	}, [conversationId, queryClient, queryKey, target, version]);
}
