// The chat tab ⇄ conversation binding, kept pure so it can be tested without a
// React tree. Two operations that MUST agree, because a chat tab's whole
// durability story rides on them:
//
//   * `bindConversation` — write the thread a chat tab is showing onto the tab
//     record. A tab opened blank ("New chat") only learns its conversation id on
//     the first send, so ChatPage writes it back here. It is what makes the
//     thread survive a relaunch (the id is part of the persisted session).
//   * `findChatTab` — the lookup `openTab` dedups on and `requestScrollToMessage`
//     targets. If a tab never got bound, this can never find it, so navigating to
//     an already-open conversation opens a SECOND tab on the same thread.
//
// Written as a pair in one file so a future change can't fix one side and leave
// the other keyed off something else.

import type { Tab } from "@/src/contexts/TabsContext.tsx";

/** The open chat tab showing `conversationId`, if any. */
export function findChatTab(
	tabs: Tab[],
	conversationId: string
): Tab | undefined {
	return tabs.find(
		(t) => t.path === "/chat" && t.conversationId === conversationId
	);
}

/**
 * The computer a tab is bound to, or `null` for the default one.
 *
 * An override naming the default node is the same authority as no override, so
 * it normalises to `null` — otherwise a tab bound to the default by name would
 * never dedupe against a plain open of the same thread.
 */
export function tabNodeKey(
	overrides: Readonly<Record<string, string>>,
	tabId: string,
	defaultNode: string
): string | null {
	const node = overrides[tabId];
	return node && node !== defaultNode ? node : null;
}

/**
 * The open chat tab showing `conversationId` ON `node` (`null` = the default
 * computer). An RNP handoff keeps the source conversation id, so after one the
 * same id lives on two computers; matching by id alone would focus the other
 * computer's copy. `overrides` is the store's `tabOverrides`, already
 * normalised through {@link tabNodeKey} by the caller when it can name the
 * default node.
 */
export function findChatTabOnNode(
	tabs: Tab[],
	conversationId: string,
	node: string | null,
	overrides: Readonly<Record<string, string>>
): Tab | undefined {
	return tabs.find(
		(t) =>
			t.path === "/chat" &&
			t.conversationId === conversationId &&
			(overrides[t.id] ?? null) === node
	);
}

/**
 * Bind `tabId` to `conversationId` — pass `undefined` to unbind.
 *
 * Returns `tabs` UNCHANGED (same reference) when nothing moves: the caller drives
 * this from an effect, and every tab write snapshots the session to localStorage,
 * so a no-op must stay a no-op.
 *
 * Unbinding is not an afterthought: a tab that starts a fresh or ghost thread has
 * to drop its old id, otherwise a later click on the OLD conversation dedups onto
 * a tab that is showing something else entirely.
 *
 * The tab's LABEL is deliberately not touched here — `useTitleBar` is its single
 * writer, and a second one would race it (a ghost thread is labelled "Temporary
 * chat", which this has no way to know).
 */
export function bindConversation(
	tabs: Tab[],
	tabId: string,
	conversationId: string | undefined
): Tab[] {
	const target = tabs.find((t) => t.id === tabId);
	if (!target || target.conversationId === conversationId) {
		return tabs;
	}
	return tabs.map((t) => (t.id === tabId ? { ...t, conversationId } : t));
}
