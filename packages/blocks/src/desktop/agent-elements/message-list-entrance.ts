/**
 * Which transcript messages are genuinely NEW — sent or received while the
 * list is on screen — and so get the bubble entrance animation.
 *
 * Everything that is merely LOADED must stay still: the history a thread opens
 * with, older pages prepended above it, a thread switch, or an optimistic id
 * swapped for its persisted one. Only ids appended after the last message the
 * list already showed count, and only a handful at a time (a reconnect that
 * syncs a backlog is a load, not a conversation).
 */
export interface BubbleEntranceState {
	conversationKey: string | null;
	/** Fresh ids stay fresh for as long as they are rendered: the attribute
	 * that drives the CSS animation must never toggle on an element that is
	 * already mounted, or the animation would replay. */
	freshIds: ReadonlySet<string>;
	ids: readonly string[];
}

/** More than this many messages arriving in one update is a load. */
export const MAX_FRESH_PER_UPDATE = 4;

const NO_FRESH_IDS: ReadonlySet<string> = new Set();

function settled(
	conversationKey: string | null,
	ids: readonly string[]
): BubbleEntranceState {
	return { conversationKey, freshIds: NO_FRESH_IDS, ids };
}

function appendedIds(
	previousIds: readonly string[],
	ids: readonly string[]
): string[] | null {
	const previous = new Set(previousIds);
	if (previous.size === 0) {
		return [...ids];
	}
	// Anchor on the newest previously shown id that survived. When none did,
	// the list was replaced wholesale (a thread switch or a reload).
	let anchorIndex = -1;
	for (let index = ids.length - 1; index >= 0; index--) {
		if (previous.has(ids[index] ?? "")) {
			anchorIndex = index;
			break;
		}
	}
	if (anchorIndex === -1) {
		return null;
	}
	return ids.slice(anchorIndex + 1).filter((id) => !previous.has(id));
}

export function reconcileBubbleEntranceState(
	state: BubbleEntranceState | null,
	conversationKey: string | null,
	ids: readonly string[]
): BubbleEntranceState {
	// A brand-new chat gains its key with (or after) its first message, so
	// null → key is the same conversation; any other key change is a switch.
	if (
		!state ||
		(state.conversationKey !== null &&
			state.conversationKey !== conversationKey)
	) {
		return settled(conversationKey, ids);
	}

	const appended = appendedIds(state.ids, ids);
	if (appended === null) {
		return settled(conversationKey, ids);
	}

	const present = new Set(ids);
	const retained = [...state.freshIds].filter((id) => present.has(id));
	const arrived = appended.length > MAX_FRESH_PER_UPDATE ? [] : appended;
	if (arrived.length === 0 && retained.length === state.freshIds.size) {
		return { conversationKey, freshIds: state.freshIds, ids };
	}
	return {
		conversationKey,
		freshIds: new Set([...retained, ...arrived]),
		ids,
	};
}
