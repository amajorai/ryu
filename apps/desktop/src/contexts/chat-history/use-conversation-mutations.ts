// Optimistic conversation-list mutations for the chat history provider: drafts,
// folder, linked pull requests, seeded titles, delete, rename, glyph and
// visibility, each written through to Core. Called only by ChatHistoryProvider.

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { type RefObject, type SetStateAction, useCallback } from "react";
import { toastActionError } from "@/src/lib/action-error.ts";
import {
	regenerateConversationTitle,
	setConversationIcon,
	setConversationPullRequestLinked as setConversationPullRequestLinkedApi,
	setConversationTitle,
	setConversationVisibility as setConversationVisibilityApi,
} from "@/src/lib/api/conversation-flags.ts";
import type { ResourceVisibility } from "@/src/lib/resource-visibility.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { coreFetch, deriveDraftTitle, UNTITLED } from "./core-conversation.ts";
import type { DraftInit } from "./types.ts";

export function useConversationMutations({
	activeNode,
	conversations,
	localDraftIds,
	ownsAuthority,
	refresh,
	setConversations,
}: {
	activeNode: Node;
	ownsAuthority: () => boolean;
	setConversations: (update: SetStateAction<Conversation[]>) => void;
	conversations: Conversation[];
	localDraftIds: RefObject<Set<string>>;
	refresh: () => Promise<void> | void;
}) {
	const createConversation = useCallback(
		(id: string, init?: DraftInit) => {
			setConversations((prev) => {
				if (prev.some((c) => c.id === id)) {
					return prev;
				}
				localDraftIds.current.add(id);
				const now = Date.now();
				const draft: Conversation = {
					id,
					agentId: init?.agentId,
					title: init?.title ?? UNTITLED,
					// The sidebar groups by this. Seeding it here is what puts a chat
					// started inside a project under that project IMMEDIATELY, instead of
					// showing up as a loose chat until Core's row (which carries the same
					// folder, stamped from the turn's cwd) replaces the draft.
					folderPath: init?.folderPath,
					messageCount: 0,
					messages: [],
					createdAt: now,
					updatedAt: now,
				};
				return [draft, ...prev];
			});
		},
		[setConversations]
	);

	const setConversationFolder = useCallback(
		(id: string, folderPath?: string) => {
			// No folder ⇒ nothing to record. Core's `set_run_metadata` COALESCEs, so a
			// turn run with no cwd never clears a folder the conversation already has;
			// mirroring that here keeps the two from disagreeing.
			if (!folderPath) {
				return;
			}
			setConversations((prev) =>
				prev.map((c) =>
					c.id === id && c.folderPath !== folderPath ? { ...c, folderPath } : c
				)
			);
		},
		[setConversations]
	);

	const setConversationPullRequestLinked = useCallback(
		async (id: string, url: string, linked: boolean): Promise<void> => {
			const { url: nodeUrl, token, userJwt } = activeNode;
			const linkedPullRequests = await setConversationPullRequestLinkedApi(
				{ url: nodeUrl, token, userJwt },
				id,
				url,
				linked
			);
			if (!ownsAuthority()) {
				return;
			}
			setConversations((prev) =>
				prev.map((conversation) =>
					conversation.id === id
						? {
								...conversation,
								linkedPullRequests: linkedPullRequests.length
									? linkedPullRequests
									: undefined,
							}
						: conversation
				)
			);
		},
		[activeNode, ownsAuthority, setConversations]
	);

	// Default chat naming, independent of any plugin: the moment the user sends,
	// the thread is called what they asked. Core derives the identical title when
	// it persists the turn, so this only removes the round trip — nothing here is
	// written back, and the guard on `UNTITLED` keeps a later send (or a title the
	// chat-title plugin already produced) from being overwritten.
	const seedTitleFromFirstMessage = useCallback(
		(id: string, content: string) => {
			const derived = deriveDraftTitle(content);
			if (!derived) {
				return;
			}
			setConversations((prev) =>
				prev.map((c) =>
					c.id === id && c.title === UNTITLED ? { ...c, title: derived } : c
				)
			);
		},
		[setConversations]
	);

	const deleteConversation = useCallback(
		async (id: string): Promise<boolean> => {
			if (!ownsAuthority()) {
				return false;
			}
			const deleted = conversations.find(
				(conversation) => conversation.id === id
			);
			setConversations((prev) => prev.filter((c) => c.id !== id));
			const { url, token, userJwt } = activeNode;
			try {
				const response = await coreFetch(
					url,
					token,
					`/api/conversations/${encodeURIComponent(id)}`,
					{ method: "DELETE" },
					userJwt
				);
				if (!response.ok) {
					throw new Error(`Failed to delete conversation: ${response.status}`);
				}
				if (!ownsAuthority()) {
					return false;
				}
				localDraftIds.current.delete(id);
				return true;
			} catch {
				if (deleted) {
					setConversations((prev) => {
						if (prev.some((conversation) => conversation.id === id)) {
							return prev;
						}
						return [...prev, deleted].sort((a, b) => b.updatedAt - a.updatedAt);
					});
				}
				return false;
			}
		},
		[activeNode, conversations, ownsAuthority, setConversations]
	);

	const autoRenameConversation = useCallback(
		async (id: string) => {
			if (!ownsAuthority()) {
				throw new Error("Chat history selection changed");
			}
			const title = await regenerateConversationTitle(activeNode, id);
			if (!ownsAuthority()) {
				throw new Error("Chat history selection changed");
			}
			setConversations((previous) =>
				previous.map((conversation) =>
					conversation.id === id ? { ...conversation, title } : conversation
				)
			);
			return title;
		},
		[activeNode, ownsAuthority, setConversations]
	);
	const renameConversation = useCallback(
		async (id: string, title: string): Promise<boolean> => {
			if (!ownsAuthority()) {
				return false;
			}
			const trimmed = title.trim();
			if (!trimmed) {
				return false;
			}
			const previous = conversations.find(
				(conversation) => conversation.id === id
			);
			if (previous?.title === trimmed) {
				return true;
			}
			setConversations((prev) =>
				prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c))
			);
			// Keep the optimistic title visible while the write is in flight. If Core
			// refuses it, roll back only this optimistic value; a newer rename remains
			// authoritative and the caller can keep its draft open for retry.
			const { url, token, userJwt } = activeNode;
			const saved = await setConversationTitle(
				{ url, token, userJwt },
				id,
				trimmed
			);
			if (!saved && previous) {
				setConversations((prev) =>
					prev.map((conversation) =>
						conversation.id === id && conversation.title === trimmed
							? { ...conversation, title: previous.title }
							: conversation
					)
				);
			}
			return ownsAuthority() && saved;
		},
		[activeNode, conversations, ownsAuthority, setConversations]
	);

	const setConversationGlyph = useCallback(
		(id: string, icon: GlyphValue) => {
			if (!ownsAuthority()) {
				return;
			}
			setConversations((prev) =>
				prev.map((c) => (c.id === id ? { ...c, icon } : c))
			);
			const { url, token, userJwt } = activeNode;
			Promise.resolve(
				setConversationIcon({ url, token, userJwt }, id, icon)
			).catch((error: unknown) => {
				toastActionError("Couldn't save the conversation icon", error);
			});
		},
		[activeNode, ownsAuthority, setConversations]
	);

	const setConversationVisibility = useCallback(
		async (id: string, visibility: ResourceVisibility) => {
			if (!ownsAuthority()) {
				return false;
			}
			setConversations((prev) =>
				prev.map((conversation) =>
					conversation.id === id
						? { ...conversation, visibility }
						: conversation
				)
			);
			const { url, token, userJwt } = activeNode;
			const success = await setConversationVisibilityApi(
				{ url, token, userJwt },
				id,
				visibility
			);
			if (!ownsAuthority()) {
				return false;
			}
			if (!success) {
				// A refresh restores the server value; keeping this best-effort mirrors
				// the existing pin/archive/icon controls.
				refresh();
			}
			return success;
		},
		[activeNode, refresh, ownsAuthority, setConversations]
	);
	return {
		autoRenameConversation,
		createConversation,
		deleteConversation,
		renameConversation,
		seedTitleFromFirstMessage,
		setConversationFolder,
		setConversationGlyph,
		setConversationPullRequestLinked,
		setConversationVisibility,
	};
}
