import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
// apps/desktop/src/store/useConversationFlagsStore.ts
//
// Pin / archive / unread flags for conversations, in ONE module-level store.
//
// These lived as `useState` sets inside `AppSidebar`, which was fine while the
// sidebar's chat rows were the only surface that read or toggled them. The tab
// context menus now offer the same rows ("Pin chat", "Mark as unread", …) for
// whatever entity a tab points at, and a second `useState` copy would be a
// live desync: two components, two sets, both write-through to the same
// localStorage keys and the same Core columns, diverging on the first toggle.
// So the state is module-level and every surface reads the same sets.
//
// Local-first, exactly as before: persisted in localStorage (Core has no
// per-user schema for unread), with pin/archive writing through to Core so the
// flag is server-backed and shared with coordinator threads + other clients. A
// failed write is non-fatal — the local mirror keeps the UI correct offline.

import { create } from "zustand";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	setConversationArchived,
	setConversationPinned,
} from "@/src/lib/api/conversation-flags.ts";
import { stopConversation } from "@/src/lib/chat-stop-registry.ts";
import {
	parseStoredConversationCounts,
	parseStoredConversationIds,
} from "./conversation-flags-storage.ts";
import { useNodeStore } from "./useNodeStore.ts";

const UNREAD_KEY = "ryu:unread-convs";
const UNREAD_MESSAGE_COUNTS_KEY = "ryu:unread-message-counts";
const LAST_MESSAGE_COUNTS_KEY = "ryu:last-message-counts";
const PINNED_KEY = "ryu:pinned-convs";
const ARCHIVED_KEY = "ryu:archived-convs";

function loadIdSet(key: string): Set<string> {
	try {
		const stored = localStorage.getItem(key);
		return parseStoredConversationIds(stored);
	} catch {
		return new Set();
	}
}

function saveIdSet(key: string, ids: Set<string>) {
	try {
		localStorage.setItem(key, JSON.stringify([...ids]));
	} catch {
		// best-effort
	}
}

function loadMessageCountMap(key: string): Map<string, number> {
	try {
		return parseStoredConversationCounts(localStorage.getItem(key));
	} catch {
		return new Map();
	}
}

function saveMessageCountMap(key: string, counts: Map<string, number>) {
	try {
		localStorage.setItem(key, JSON.stringify([...counts]));
	} catch {
		// best-effort
	}
}

function isValidMessageCount(value: number | undefined): value is number {
	return isNativeNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

/** The active node's API target, resolved at call time (never captured). */
function activeTarget() {
	return toTarget(useNodeStore.getState().getActiveNode());
}

interface ConversationFlagsState {
	archivedIds: Set<string>;
	lastObservedMessageCounts: Map<string, number>;
	markRead: (id: string) => void;
	markUnread: (id: string) => void;
	/** Union server-backed pin/archive state into the local sets (never removes). */
	mergeServerFlags: (input: { archived: string[]; pinned: string[] }) => void;
	/** Track per-conversation message totals and unread deltas from the last read. */
	observeMessageCounts: (
		conversations: readonly { id: string; messageCount?: number }[],
		activeConversationId: string | null
	) => void;
	pinnedIds: Set<string>;
	toggleArchive: (id: string) => void;
	togglePin: (id: string) => void;
	unreadIds: Set<string>;
	unreadMessageCounts: Map<string, number>;
}

/** Union `ids` into the persisted set at `key`, returning the same set if unchanged. */
function unionInto(prev: Set<string>, key: string, ids: string[]): Set<string> {
	if (ids.every((id) => prev.has(id))) {
		return prev;
	}
	const next = new Set(prev);
	for (const id of ids) {
		next.add(id);
	}
	saveIdSet(key, next);
	return next;
}

export const useConversationFlagsStore = create<ConversationFlagsState>(
	(set, get) => ({
		archivedIds: loadIdSet(ARCHIVED_KEY),
		lastObservedMessageCounts: loadMessageCountMap(LAST_MESSAGE_COUNTS_KEY),
		pinnedIds: loadIdSet(PINNED_KEY),
		unreadIds: loadIdSet(UNREAD_KEY),
		unreadMessageCounts: loadMessageCountMap(UNREAD_MESSAGE_COUNTS_KEY),

		togglePin: (id) => {
			const next = !get().pinnedIds.has(id);
			set((state) => {
				const ids = new Set(state.pinnedIds);
				if (next) {
					ids.add(id);
				} else {
					ids.delete(id);
				}
				saveIdSet(PINNED_KEY, ids);
				return { pinnedIds: ids };
			});
			void setConversationPinned(activeTarget(), id, next);
		},

		toggleArchive: (id) => {
			const next = !get().archivedIds.has(id);
			if (next) {
				stopConversation(id);
			}
			set((state) => {
				const ids = new Set(state.archivedIds);
				if (next) {
					ids.add(id);
				} else {
					ids.delete(id);
				}
				saveIdSet(ARCHIVED_KEY, ids);
				return { archivedIds: ids };
			});
			void setConversationArchived(activeTarget(), id, next);
		},

		markRead: (id) =>
			set((state) => {
				if (!(state.unreadIds.has(id) || state.unreadMessageCounts.has(id))) {
					return state;
				}
				const ids = new Set(state.unreadIds);
				ids.delete(id);
				const counts = new Map(state.unreadMessageCounts);
				counts.delete(id);
				saveIdSet(UNREAD_KEY, ids);
				saveMessageCountMap(UNREAD_MESSAGE_COUNTS_KEY, counts);
				return { unreadIds: ids, unreadMessageCounts: counts };
			}),

		markUnread: (id) =>
			set((state) => {
				if (state.unreadIds.has(id)) {
					return state;
				}
				const ids = new Set(state.unreadIds);
				ids.add(id);
				const counts = new Map(state.unreadMessageCounts);
				counts.set(id, 1);
				saveIdSet(UNREAD_KEY, ids);
				saveMessageCountMap(UNREAD_MESSAGE_COUNTS_KEY, counts);
				return { unreadIds: ids, unreadMessageCounts: counts };
			}),

		observeMessageCounts: (conversations, activeConversationId) =>
			set((state) => {
				let lastObservedMessageCounts: Map<string, number> | undefined;
				let unreadIds: Set<string> | undefined;
				let unreadMessageCounts: Map<string, number> | undefined;
				const currentMessageCounts = () =>
					lastObservedMessageCounts ?? state.lastObservedMessageCounts;
				const currentUnreadIds = () => unreadIds ?? state.unreadIds;
				const currentUnreadCounts = () =>
					unreadMessageCounts ?? state.unreadMessageCounts;

				for (const conversation of conversations) {
					const { id, messageCount } = conversation;
					if (!(id && isValidMessageCount(messageCount))) {
						continue;
					}

					const previousCount = currentMessageCounts().get(id);
					if (previousCount === undefined || previousCount !== messageCount) {
						lastObservedMessageCounts ??= new Map(
							state.lastObservedMessageCounts
						);
						lastObservedMessageCounts.set(id, messageCount);
					}

					if (id === activeConversationId) {
						if (currentUnreadIds().has(id) || currentUnreadCounts().has(id)) {
							unreadIds ??= new Set(state.unreadIds);
							unreadMessageCounts ??= new Map(state.unreadMessageCounts);
							unreadIds.delete(id);
							unreadMessageCounts.delete(id);
						}
						continue;
					}

					if (
						previousCount !== undefined &&
						messageCount > previousCount &&
						id !== activeConversationId
					) {
						const wasUnread = currentUnreadIds().has(id);
						unreadIds ??= new Set(state.unreadIds);
						unreadIds.add(id);
						unreadMessageCounts ??= new Map(state.unreadMessageCounts);
						const previousUnreadCount = wasUnread
							? (currentUnreadCounts().get(id) ?? 1)
							: 0;
						unreadMessageCounts.set(
							id,
							previousUnreadCount + (messageCount - previousCount)
						);
					}
				}

				if (!(lastObservedMessageCounts || unreadIds || unreadMessageCounts)) {
					return state;
				}
				if (lastObservedMessageCounts) {
					saveMessageCountMap(
						LAST_MESSAGE_COUNTS_KEY,
						lastObservedMessageCounts
					);
				}
				if (unreadIds) {
					saveIdSet(UNREAD_KEY, unreadIds);
				}
				if (unreadMessageCounts) {
					saveMessageCountMap(UNREAD_MESSAGE_COUNTS_KEY, unreadMessageCounts);
				}
				return {
					lastObservedMessageCounts:
						lastObservedMessageCounts ?? state.lastObservedMessageCounts,
					unreadIds: unreadIds ?? state.unreadIds,
					unreadMessageCounts: unreadMessageCounts ?? state.unreadMessageCounts,
				};
			}),

		mergeServerFlags: ({ pinned, archived }) =>
			set((state) => {
				const nextPinned = unionInto(state.pinnedIds, PINNED_KEY, pinned);
				const nextArchived = unionInto(
					state.archivedIds,
					ARCHIVED_KEY,
					archived
				);
				if (
					nextPinned === state.pinnedIds &&
					nextArchived === state.archivedIds
				) {
					return state;
				}
				return { pinnedIds: nextPinned, archivedIds: nextArchived };
			}),
	})
);
