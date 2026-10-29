// apps/desktop/src/lib/agent-ui-state-merge.ts
//
// Pure helpers for the generative-UI state host (useAgentUiStateHost.ts): how a
// fresh server read of a conversation's saved widget states combines with the
// copies this client already holds.

import type { AgentUiSavedState } from "@ryu/blocks/desktop/agent-elements/agent-ui/state-host-context.tsx";

export type SavedStates = Map<string, AgentUiSavedState>;

/** Structural equality for JSON values, ignoring object key order (Core may
 *  return keys in a different order than the client wrote them). */
export function jsonEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (
		left === null ||
		right === null ||
		typeof left !== "object" ||
		typeof right !== "object" ||
		Array.isArray(left) !== Array.isArray(right)
	) {
		return false;
	}
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) {
		return false;
	}
	return leftKeys.every(
		(key) =>
			Object.hasOwn(right, key) &&
			jsonEqual(Reflect.get(left, key), Reflect.get(right, key))
	);
}

export interface MergedServerRead {
	/** Whether this differs from the local copies, so widgets must remount. */
	changed: boolean;
	/** Whether any local copy outranked the server's, so the cached read must
	 *  be replaced too or it would lose that copy. */
	keptLocal: boolean;
	states: SavedStates;
}

/**
 * The saved states a server read leaves the client with: the server copy, except
 * for widgets whose local copy may be newer than the read (`keepLocal`: a save
 * still unanswered, or one started or settled after the read was requested, which
 * Core may have applied only after answering the read). A widget the server
 * no longer has and that is not newer locally is dropped. Where the server copy
 * equals the local one, the local object is kept, so a read that changed one
 * widget does not hand every other widget (or artifact page, whose frame reloads
 * on a new saved-state object) a fresh copy of the same value.
 */
export function mergeServerRead(
	local: SavedStates,
	server: SavedStates,
	keepLocal: (toolCallId: string) => boolean
): MergedServerRead {
	const states: SavedStates = new Map();
	for (const [toolCallId, saved] of server) {
		const current = local.get(toolCallId);
		states.set(
			toolCallId,
			current !== undefined && jsonEqual(current, saved) ? current : saved
		);
	}
	let keptLocal = false;
	for (const [toolCallId, saved] of local) {
		if (keepLocal(toolCallId) && !jsonEqual(server.get(toolCallId), saved)) {
			states.set(toolCallId, saved);
			keptLocal = true;
		}
	}
	let changed = states.size !== local.size;
	if (!changed) {
		for (const [toolCallId, saved] of states) {
			if (!jsonEqual(local.get(toolCallId), saved)) {
				changed = true;
				break;
			}
		}
	}
	return { changed, keptLocal, states };
}
