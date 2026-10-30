import { useCallback, useEffect, useRef, useState } from "react";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatPluginFlagsInput = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection>;

/** Composer plugin flags and temporary (ghost) chat mode. */
export function useChatPluginFlags({
	initialPluginFlags,
	initialGhost,
	ghostChatsPluginEnabled,
	pluginContributionsSettled,
	ghostChatActiveRef,
	convId,
	currentTabId,
	bindTabConversation,
}: UseChatPluginFlagsInput) {
	// Generic plugin composer toggles (`composer_controls`): a flag→on map keyed by
	// each control's `flag`. Held in state (drives the toggle's rendered `enabled`)
	// plus a ref the once-created transport body closure reads when merging the
	// per-request `plugin_flags` — same pattern as the double-check flag above.
	const [pluginFlags, setPluginFlags] = useState<Record<string, boolean>>(
		() => ({ ...initialPluginFlags })
	);
	const pluginFlagsRef = useRef<Record<string, boolean>>({});
	pluginFlagsRef.current = pluginFlags;

	// One-shot flags marked by an `action` composer control when it fires. Kept in
	// a ref rather than state (the button holds no visual state) and CONSUMED by
	// the next request's body, exactly like `skipNextUserAppendRef`: a button press
	// belongs to the turn it precedes, not to every turn after it.
	const pendingActionFlagsRef = useRef<Record<string, boolean>>({});
	const firePluginActionFlag = useCallback((flag: string) => {
		pendingActionFlagsRef.current = {
			...pendingActionFlagsRef.current,
			[flag]: true,
		};
	}, []);

	// Temporary chat: when on, every turn is sent with `persist: false` so Core
	// writes nothing to the conversation store, and a temporary chat is never
	// registered in the sidebar history — it lives only in this tab's memory and is
	// gone on close or when a fresh chat starts. Ryu's incognito thread. A ref
	// mirrors the toggle so the once-created transport body closure reads the live
	// value (same pattern as the double-check flag above).
	// Seeded from the tab when the launchpad's "+" turned it on before this thread
	// existed, so the very first turn is already unsaved (flipping it after mount
	// would be too late — the turn would have persisted).
	const [ghostMode, setGhostMode] = useState(Boolean(initialGhost));
	// A launchpad-seeded temporary chat may render before the contribution fetch lands.
	// Keep that initial privacy behavior until the feed settles, then require the
	// plugin declaration for every subsequent temporary-chat turn.
	const ghostChatActive =
		ghostMode &&
		(ghostChatsPluginEnabled ||
			(Boolean(initialGhost) && !pluginContributionsSettled));
	ghostChatActiveRef.current = ghostChatActive;
	const ghostModeRef = useRef(false);
	ghostModeRef.current = ghostChatActive;
	useEffect(() => {
		if (pluginContributionsSettled && !ghostChatsPluginEnabled && ghostMode) {
			setGhostMode(false);
		}
	}, [ghostChatsPluginEnabled, ghostMode, pluginContributionsSettled]);

	// Write this tab's thread back onto its Tab record. A tab opened blank ("New
	// chat") only learns its conversation id on the first send, and nothing used
	// to tell TabsContext — so the tab stayed unbound for its whole life:
	// session restore reopened it EMPTY (the thread was only reachable from the
	// sidebar), and a sidebar click on that same thread missed `openTab`'s
	// conversation dedup and stacked a SECOND tab on it. Two chat tabs on one
	// conversation share a single `useChat({ id })` instance, so the late mount's
	// blank state clobbers the live one and both stop updating — the "opened it
	// again and the new tab is broken" report.
	//
	// A temporary thread never binds: it must leave no durable trace, and
	// a persisted binding would restore a tab pointing at a conversation Core
	// never wrote. Unbinding is equally load-bearing — a tab that starts a fresh
	// thread must drop its old id, or a click on the OLD conversation would dedup
	// onto a tab that is showing something else.
	//
	// The binding carries the id only, never a title: the tab label already has a
	// single writer (`useTitleBar` → `updateTabTitle`, below), and a second one
	// here would race it for ghost threads ("Temporary chat" vs the default).
	const boundConversationId = ghostChatActive
		? undefined
		: (convId ?? undefined);
	useEffect(() => {
		if (!currentTabId) {
			return;
		}
		bindTabConversation(currentTabId, boundConversationId);
	}, [currentTabId, boundConversationId, bindTabConversation]);

	// Plugin notes (e.g. the double-check review) arrive as `data-plugin_note`
	// stream parts; dismissed ids are tracked so a note clears once acknowledged.
	const [dismissedPluginNotes, setDismissedPluginNotes] = useState<Set<string>>(
		() => new Set()
	);
	return {
		pluginFlags,
		setPluginFlags,
		pluginFlagsRef,
		pendingActionFlagsRef,
		firePluginActionFlag,
		setGhostMode,
		ghostChatActive,
		ghostModeRef,
		dismissedPluginNotes,
		setDismissedPluginNotes,
	} as const;
}
