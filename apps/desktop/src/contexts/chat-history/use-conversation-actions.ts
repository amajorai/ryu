// Conversation actions for the chat history provider that call Core and then
// reconcile the list: re-file under a folder project, fork, edit, regenerate
// and select a message version. Called only by ChatHistoryProvider.

import type { RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { setConversationFolder as setConversationFolderApi } from "@/src/lib/api/conversation-flags.ts";
import { setThreadProject } from "@/src/lib/api/hierarchy.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	type CoreConversationSummary,
	coreFetch,
	summaryToConversation,
} from "./core-conversation.ts";

export function useConversationActions({
	activeNode,
	conversationsRef,
	ownsAuthority,
	setConversations,
}: {
	activeNode: Node;
	ownsAuthority: () => boolean;
	setConversations: (update: SetStateAction<Conversation[]>) => void;
	conversationsRef: RefObject<Conversation[]>;
}) {
	// Re-file a chat under another folder project, or out of every project with
	// `null`. Core's folder is what the sidebar groups by; the node project id
	// (Projects app) is placed from that folder by `useFolderProjectMigration`,
	// which never re-places a thread that already has a project. So a chat that
	// sits in a node project is detached from it here first — otherwise moving it
	// would change its sidebar bucket while its memory and coordinator stayed
	// with the old project. A project's main thread belongs to its project and is
	// never moved.
	const placeConversationInFolder = useCallback(
		async (id: string, folderPath: string | null): Promise<boolean> => {
			if (!ownsAuthority()) {
				return false;
			}
			const hierarchy = conversationsRef.current.find(
				(c) => c.id === id
			)?.hierarchy;
			if (hierarchy?.role === "main") {
				return false;
			}
			const target: ApiTarget = {
				url: activeNode.url,
				token: activeNode.token,
				userJwt: activeNode.userJwt,
			};
			const success = await setConversationFolderApi(target, id, folderPath);
			if (!(success && ownsAuthority())) {
				return false;
			}
			const previousProjectId = hierarchy?.projectId;
			if (previousProjectId) {
				// Best effort: on failure the chat keeps its old node project until
				// the next move, but the folder (and so the sidebar) already moved.
				await setThreadProject(target, id, null).catch(() => undefined);
			}
			setConversations((prev) =>
				prev.map((conversation) =>
					conversation.id === id
						? {
								...conversation,
								folderPath: folderPath ?? undefined,
								hierarchy:
									previousProjectId && conversation.hierarchy
										? {
												...conversation.hierarchy,
												projectId: undefined,
												spawnedByConversationId: undefined,
											}
										: conversation.hierarchy,
							}
						: conversation
				)
			);
			return ownsAuthority();
		},
		[activeNode, ownsAuthority, setConversations]
	);
	const moveConversationToProject = useCallback(
		(id: string, folderPath: string | null) =>
			placeConversationInFolder(id, folderPath),
		[placeConversationInFolder]
	);
	const removeConversationFromProject = useCallback(
		(id: string) => placeConversationInFolder(id, null),
		[placeConversationInFolder]
	);

	const forkConversation = useCallback(
		async (id: string, messageId?: string): Promise<string | null> => {
			if (!ownsAuthority()) {
				return null;
			}
			const { url, token, userJwt } = activeNode;
			try {
				const res = await coreFetch(
					url,
					token,
					`/api/conversations/${encodeURIComponent(id)}/fork`,
					{
						method: "POST",
						body: JSON.stringify(messageId ? { message_id: messageId } : {}),
					},
					userJwt
				);
				if (!res.ok) {
					return null;
				}
				const data: { conversation?: CoreConversationSummary } =
					await res.json();
				if (!(data.conversation && ownsAuthority())) {
					return null;
				}
				const forked = summaryToConversation(data.conversation);
				setConversations((prev) =>
					prev.some((c) => c.id === forked.id) ? prev : [forked, ...prev]
				);
				return forked.id;
			} catch {
				return null;
			}
		},
		[activeNode, ownsAuthority, setConversations]
	);

	const editMessage = useCallback(
		async (
			id: string,
			messageId: string,
			content: string
		): Promise<string | null> => {
			if (!ownsAuthority()) {
				return null;
			}
			const { url, token, userJwt } = activeNode;
			try {
				const res = await coreFetch(
					url,
					token,
					`/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/edit`,
					{ method: "POST", body: JSON.stringify({ content }) },
					userJwt
				);
				if (!res.ok) {
					return null;
				}
				const data: { message_id?: string } = await res.json();
				return ownsAuthority() ? (data.message_id ?? null) : null;
			} catch {
				return null;
			}
		},
		[activeNode, ownsAuthority]
	);

	const regenerateMessage = useCallback(
		async (id: string, messageId: string): Promise<boolean> => {
			if (!ownsAuthority()) {
				return false;
			}
			const { url, token, userJwt } = activeNode;
			try {
				const res = await coreFetch(
					url,
					token,
					`/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/regenerate`,
					{ method: "POST" },
					userJwt
				);
				return ownsAuthority() && res.ok;
			} catch {
				return false;
			}
		},
		[activeNode, ownsAuthority]
	);

	const selectVersion = useCallback(
		async (id: string, versionId: string): Promise<boolean> => {
			if (!ownsAuthority()) {
				return false;
			}
			const { url, token, userJwt } = activeNode;
			try {
				const res = await coreFetch(
					url,
					token,
					`/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(versionId)}/select`,
					{ method: "POST" },
					userJwt
				);
				return ownsAuthority() && res.ok;
			} catch {
				return false;
			}
		},
		[activeNode, ownsAuthority]
	);
	return {
		editMessage,
		forkConversation,
		moveConversationToProject,
		regenerateMessage,
		removeConversationFromProject,
		selectVersion,
	};
}
