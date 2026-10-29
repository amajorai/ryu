import { useCallback, useEffect, useRef, useState } from "react";
import {
	assignConversationToBotChatSection,
	type BotChatSectionState,
	createBotChatSection,
	nestBotChatSection,
	normalizeBotChatSections,
	removeBotChatSection,
	renameBotChatSection,
} from "@/src/lib/bot-chat-sections.ts";
import { SETTINGS_REMOTE_APPLIED_EVENT } from "@/src/lib/settings-sync/local-store.ts";

// Account-level: these keys are on the settings-sync allowlist, so sections
// follow the user to every desktop they sign into.
export const BOT_CHAT_SECTIONS_STORAGE_KEY = "ryu:bot-chat-sections:v1";
export const BOT_CHAT_SECTION_ORDER_KEY = "ryu:bot-chat-section-order:v1";
export const BOT_CHAT_SECTION_COLLAPSED_KEY =
	"ryu:bot-chat-section-collapsed:v1";

function readState(): BotChatSectionState {
	try {
		const stored = localStorage.getItem(BOT_CHAT_SECTIONS_STORAGE_KEY);
		return stored
			? normalizeBotChatSections(JSON.parse(stored))
			: normalizeBotChatSections(null);
	} catch {
		return normalizeBotChatSections(null);
	}
}

function writeState(state: BotChatSectionState) {
	try {
		localStorage.setItem(BOT_CHAT_SECTIONS_STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Best-effort persistence. The in-memory state remains usable.
	}
}

/** Every mounted instance in this window. The docked and the floating sidebar
 *  each mount the hook, and `storage` events never reach the window that
 *  wrote, so a change is handed to the other instances directly; otherwise
 *  one instance's next write would drop a group the other just made. */
const sameWindowInstances = new Set<(state: BotChatSectionState) => void>();

function newSectionId(): string {
	if (globalThis.crypto?.randomUUID !== undefined) {
		return `section-${crypto.randomUUID()}`;
	}
	return `section-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useBotChatSections() {
	const [state, setState] = useState<BotChatSectionState>(readState);
	// The latest committed state. Every update starts from here rather than from
	// the render's snapshot, so several updates in one event (a multi-chat drop)
	// compose instead of each one overwriting the last.
	const latest = useRef(state);

	// Pick up sections changed by another instance in this window, in another
	// window (`storage`), or synced from another device (the settings-sync apply
	// event).
	useEffect(() => {
		const adopt = (next: BotChatSectionState) => {
			latest.current = next;
			setState(next);
		};
		const reload = (key: string | null | undefined) => {
			if (key === BOT_CHAT_SECTIONS_STORAGE_KEY) {
				adopt(readState());
			}
		};
		sameWindowInstances.add(adopt);
		const onStorage = (event: StorageEvent) => reload(event.key);
		const onRemote = (event: Event) =>
			// SAFETY: local-store.notifyRemoteApplied publishes this named event with
			// detail { key: string }; the DOM EventListener parameter erases that detail.
			reload((event as CustomEvent<{ key?: string }>).detail?.key);
		window.addEventListener("storage", onStorage);
		window.addEventListener(SETTINGS_REMOTE_APPLIED_EVENT, onRemote);
		return () => {
			sameWindowInstances.delete(adopt);
			window.removeEventListener("storage", onStorage);
			window.removeEventListener(SETTINGS_REMOTE_APPLIED_EVENT, onRemote);
		};
	}, []);

	/** Apply `update` to the latest state; returns whether anything changed. */
	const commit = useCallback(
		(update: (current: BotChatSectionState) => BotChatSectionState) => {
			const current = latest.current;
			const next = update(current);
			if (next === current) {
				return false;
			}
			latest.current = next;
			setState(next);
			writeState(next);
			for (const adopt of sameWindowInstances) {
				adopt(next);
			}
			return true;
		},
		[]
	);

	const createSection = useCallback(
		(name: string) => {
			const id = newSectionId();
			const created = commit((current) =>
				createBotChatSection(current, { id, name })
			);
			return created ? id : null;
		},
		[commit]
	);

	const renameSection = useCallback(
		(id: string, name: string) => {
			commit((current) => renameBotChatSection(current, id, name));
		},
		[commit]
	);

	const deleteSection = useCallback(
		(id: string) => {
			commit((current) => removeBotChatSection(current, id));
		},
		[commit]
	);

	const assignConversation = useCallback(
		(conversationId: string, sectionId: string) => {
			commit((current) =>
				assignConversationToBotChatSection(current, conversationId, sectionId)
			);
		},
		[commit]
	);

	/** File several chats under one section in a single update and write. */
	const assignConversations = useCallback(
		(conversationIds: readonly string[], sectionId: string) => {
			commit((current) => {
				let next = current;
				for (const conversationId of conversationIds) {
					next = assignConversationToBotChatSection(
						next,
						conversationId,
						sectionId
					);
				}
				return next;
			});
		},
		[commit]
	);

	const nestSection = useCallback(
		(id: string, parentId: string | null) => {
			commit((current) => nestBotChatSection(current, id, parentId));
		},
		[commit]
	);

	return {
		assignConversation,
		assignConversations,
		assignments: state.assignments,
		createSection,
		deleteSection,
		nestSection,
		renameSection,
		sections: state.sections,
	};
}
