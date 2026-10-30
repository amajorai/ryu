// One handler bag for every sidebar chat row whose identity never changes.
//
// `buildSidebarChatRowHandlers` returns a fresh object (and fresh closures) on
// every sidebar render, so a memoized row could never skip a render. This hook
// keeps the latest bag in a ref and hands rows a stable facade instead: data
// fields read through to the latest bag, and function fields are stable
// forwarders that always call the latest closure, even when a row captured them
// several renders ago. `ChatRow` derives its own memo keys (active, pinned,
// unread, …) from the facade, so a row re-renders only when something it shows
// changes.

import { useRef } from "react";
import type { ChatRowHandlers } from "./sidebar-chat-row-types.ts";
import type { SidebarChatBulkActions } from "./sidebar-chat-selection.tsx";

const HANDLER_KEYS = {
	activeConversationId: true,
	agents: true,
	archivedIds: true,
	bulk: true,
	canMakePrivate: true,
	loadMessages: true,
	onAddScheduledTask: true,
	onAutoRenameConversation: true,
	onDeleteConversation: true,
	onForkConversation: true,
	onJumpToMessage: true,
	onMarkRead: true,
	onMarkUnread: true,
	onMoveToProject: true,
	onOpenInNewTab: true,
	onOpenInNewWindow: true,
	onOpenNewSideChat: true,
	onOpenQuickPreview: true,
	onOpenQuickReply: true,
	onOpenSideChat: true,
	onRemoveFromProject: true,
	onRenameConversation: true,
	onRequestConversationVisibility: true,
	onSelectConversation: true,
	onSetConversationIcon: true,
	onToggleArchive: true,
	onTogglePin: true,
	pinnedIds: true,
	projectNameForFolder: true,
	projectTargets: true,
	pullRequestsEnabled: true,
	schedulingEnabled: true,
	sideChatsEnabled: true,
	target: true,
	unreadIds: true,
} satisfies Record<keyof ChatRowHandlers, true>;

const BULK_KEYS = {
	deleteMany: true,
	dropTarget: true,
	moveToProject: true,
	openInNewTabs: true,
	projects: true,
	setArchived: true,
	setPinned: true,
	setRead: true,
} satisfies Record<keyof SidebarChatBulkActions, true>;

type AnyFunction = (...args: never[]) => unknown;

/** A read-through facade over `read()`: values come from the latest object,
 *  functions are wrapped once in a forwarder that calls the latest one (and the
 *  field reads `undefined` while the latest object has no function there). */
function readThroughFacade<T extends object>(
	keys: readonly (keyof T)[],
	read: () => T,
	nested: Partial<Record<keyof T, unknown>> = {}
): T {
	const forwarders = new Map<keyof T, AnyFunction>();
	const facade = {} as T;
	for (const key of keys) {
		Object.defineProperty(facade, key, {
			enumerable: true,
			get() {
				const value = read()[key];
				if (key in nested && value) {
					return nested[key];
				}
				if (typeof value !== "function") {
					return value;
				}
				let forward = forwarders.get(key);
				if (!forward) {
					forward = (...args: never[]) => (read()[key] as AnyFunction)(...args);
					forwarders.set(key, forward);
				}
				return forward;
			},
		});
	}
	return facade;
}

export function useStableChatRowHandlers(
	latest: ChatRowHandlers
): ChatRowHandlers {
	const latestRef = useRef(latest);
	// Written during render, before the rows below read it in the same pass.
	latestRef.current = latest;
	const facadeRef = useRef<ChatRowHandlers | null>(null);
	if (!facadeRef.current) {
		const readLatest = () => latestRef.current;
		const bulk = readThroughFacade(
			Object.keys(BULK_KEYS) as (keyof SidebarChatBulkActions)[],
			() => latestRef.current.bulk as SidebarChatBulkActions
		);
		facadeRef.current = readThroughFacade(
			Object.keys(HANDLER_KEYS) as (keyof ChatRowHandlers)[],
			readLatest,
			{ bulk }
		);
	}
	return facadeRef.current;
}
