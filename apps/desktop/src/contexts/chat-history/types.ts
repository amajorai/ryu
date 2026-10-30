// Shared types for the chat history context: its value, history fetch results,
// and optimistic draft seeds.

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import type { ResourceVisibility } from "@/src/lib/resource-visibility.ts";
import type { Conversation, Message } from "@/types/chat.ts";

/** Outcome of a history fetch. An empty thread and an unreachable node produce
 * the same `messages: []`, and telling them apart is the whole difference
 * between "this chat is new" and "this chat has not loaded" — see
 * `loadMessagesResult`. */
export interface LoadMessagesResult {
	hasOlderMessages?: boolean;
	messages: Message[];
	olderMessagesCursor?: string;
	status: "error" | "ok";
}

export interface ChatHistoryContextValue {
	activeConversationId: string | null;
	autoRenameConversation: (id: string) => Promise<string>;
	conversations: Conversation[];
	/** True when the latest conversation-list fetch failed (Core offline, the
	 * request refused). Cleared by the next successful fetch or a node switch.
	 * Lets a consumer tell "no conversations" from "could not load them". */
	conversationsLoadFailed?: boolean;
	/** True while the first conversation-list fetch for this node is in flight.
	 * Consumers must gate a skeleton on `conversations.length === 0` as well —
	 * `refresh` re-runs on node/preview changes and must not flash over a list
	 * that is already on screen. */
	conversationsLoading: boolean;
	/** Optimistically add a draft conversation locally; it is persisted in Core
	 * by the chat stream once the first message is sent.
	 *
	 * Pass `folderPath` whenever a workspace folder is active — the sidebar
	 * buckets rows by it, so a draft created without it lands in the loose
	 * "Chats" list and only moves under its project when Core's row arrives
	 * after the first turn. See {@link DraftInit}. */
	createConversation: (id: string, init?: DraftInit) => void;
	/** Delete from Core and update local history. Resolves false on failure and
	 * restores the optimistically removed row so the caller can offer a retry. */
	deleteConversation: (id: string) => Promise<boolean>;
	/** Edit a user message in place: creates a new version (sibling) carrying
	 * `content` and switches the active branch to it. Returns the new message id
	 * (the caller streams a reply with skip_user_append), or null on failure. */
	editMessage: (
		id: string,
		messageId: string,
		content: string
	) => Promise<string | null>;
	/** Branch (fork) a conversation into a new one, copying history up to (and
	 * including) `messageId`. Returns the new conversation's id, or null on
	 * failure. The new conversation is added to the local list optimistically. */
	forkConversation: (id: string, messageId?: string) => Promise<string | null>;
	getConversation: (id: string) => Conversation | undefined;
	listConversations: () => Conversation[];
	/** Fetch a conversation's full message history from Core. Returns `[]` for a
	 * failed fetch as well as an empty thread — use `loadMessagesResult` when the
	 * caller has to tell those apart. */
	loadMessages: (id: string) => Promise<Message[]>;
	/** Fetch the newest message page, or the page immediately before `before`.
	 * The cursor is an opaque Core message id and is only advanced after the
	 * page has been merged into the visible transcript. */
	loadMessagesPageResult: (
		id: string,
		before?: string,
		options?: { fresh?: boolean }
	) => Promise<LoadMessagesResult>;
	/** `loadMessages` with the transport outcome kept: `status: "error"` means the
	 * node could not be reached (or answered non-2xx), NOT that the conversation
	 * is empty. The chat surface needs the distinction to show "still loading /
	 * couldn't load" instead of the new-chat greeting. */
	loadMessagesResult: (id: string) => Promise<LoadMessagesResult>;
	/** Re-file a chat under the folder project rooted at `folderPath` (its
	 * primary folder), so the sidebar lists it under that project; `null` takes it
	 * out of every project. Resolves false when Core refuses the write or the chat
	 * is a project's main thread. */
	moveConversationToProject: (
		id: string,
		folderPath: string | null
	) => Promise<boolean>;
	/** Start fetching a conversation's newest message page ahead of opening it
	 * (hover or focus on a link to it). The next `loadMessagesPageResult(id)`
	 * uses the fetch once if it is still fresh, so the chat renders without the
	 * history skeleton. Safe to call repeatedly. */
	prefetchConversation: (id: string) => void;
	/** Re-sync the conversation list from Core. */
	refresh: () => void;
	/** Prepare to regenerate an assistant message: points the active leaf at the
	 * user turn above it so a subsequent stream appends a fresh assistant version.
	 * Returns true on success. */
	regenerateMessage: (id: string, messageId: string) => Promise<boolean>;
	removeConversationFromProject: (id: string) => Promise<boolean>;
	/** Rename a conversation optimistically. Resolves false when Core refuses the
	 * write and restores the previous title so the caller can offer a retry. */
	renameConversation: (id: string, title: string) => Promise<boolean>;
	/** Name a still-unnamed conversation after the message being sent, using the
	 * same rule Core applies when it persists the turn. Local state only — this is
	 * NOT a rename, so it never marks the title user-chosen and never blocks the
	 * chat-title plugin from replacing it. A no-op once the row has a real title. */
	seedTitleFromFirstMessage: (id: string, content: string) => void;
	/** Switch the active version at a branch point to `versionId`; the caller then
	 * reloads the active path to re-render the selected branch. */
	selectVersion: (id: string, versionId: string) => Promise<boolean>;
	setActiveConversationId: (id: string | null) => void;
	/** Record which workspace folder a conversation is running in, locally.
	 *
	 * Local state only — Core stamps the same value itself from the turn's `cwd`
	 * (`set_run_metadata`), so this is not a write-through, it just removes the
	 * wait. Call it at send time with the folder the turn is about to run
	 * against: a draft created before the user switched folders would otherwise
	 * sit under the wrong project until the list refreshes. */
	setConversationFolder: (id: string, folderPath?: string) => void;
	/** Set or clear a conversation glyph (optimistic + Core write-through). */
	setConversationGlyph: (id: string, icon: GlyphValue) => void;
	/** Link or unlink a GitHub pull request URL (Core write-through). Throws
	 * Core's validation error so the caller can surface it. */
	setConversationPullRequestLinked: (
		id: string,
		url: string,
		linked: boolean
	) => Promise<void>;
	/** Set a conversation's private or team visibility (optimistic + Core write-through). */
	setConversationVisibility: (
		id: string,
		visibility: ResourceVisibility
	) => Promise<boolean>;
}

/** The fields a caller may seed on an optimistic draft conversation. */
export interface DraftInit {
	agentId?: string;
	/** Workspace folder the chat belongs to — what the sidebar groups by. */
	folderPath?: string;
	title?: string;
}
