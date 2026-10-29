import {
	jsonResponseDocumentSchema,
	type RyuJsonValue,
} from "@ryu/app-host/json-values";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { safeValidateUIMessages, type UIMessage } from "ai";
import {
	createContext,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useMessagingRows } from "@/src/hooks/useAgentRowStyle.ts";
import { useSidebarChatPreview } from "@/src/hooks/useSidebarChatPreview.ts";
import { useInterfaceSurfaceSelected } from "@/src/interfaces/interface-store.ts";
import { useInterfaceActive } from "@/src/interfaces/use-interface-active.ts";
import { toastActionError } from "@/src/lib/action-error.ts";
import {
	type ApiTarget,
	type AuthenticatedFetchOptions,
	authenticatedFetch,
} from "@/src/lib/api/client.ts";
import {
	regenerateConversationTitle,
	setConversationFolder as setConversationFolderApi,
	setConversationIcon,
	setConversationPullRequestLinked as setConversationPullRequestLinkedApi,
	setConversationTitle,
	setConversationVisibility as setConversationVisibilityApi,
} from "@/src/lib/api/conversation-flags.ts";
import { setThreadProject } from "@/src/lib/api/hierarchy.ts";
import { coalesceCalls } from "@/src/lib/coalesce-calls.ts";
import { parseContinuedOn } from "@/src/lib/continued-on.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import { createPrefetchCache } from "@/src/lib/prefetch-cache.ts";
import {
	type ResourceVisibility,
	toResourceVisibility,
} from "@/src/lib/resource-visibility.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import type { Conversation, Message, ThreadHierarchy } from "@/types/chat.ts";

/** Outcome of a history fetch. An empty thread and an unreachable node produce
 * the same `messages: []`, and telling them apart is the whole difference
 * between "this chat is new" and "this chat has not loaded" — see
 * `loadMessagesResult`. */
interface LoadMessagesResult {
	hasOlderMessages?: boolean;
	messages: Message[];
	olderMessagesCursor?: string;
	status: "error" | "ok";
}

interface ChatHistoryContextValue {
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
interface DraftInit {
	agentId?: string;
	/** Workspace folder the chat belongs to — what the sidebar groups by. */
	folderPath?: string;
	title?: string;
}

const ChatHistoryContext = createContext<ChatHistoryContextValue | null>(null);

export function useChatHistoryContext() {
	const ctx = useContext(ChatHistoryContext);
	if (!ctx) {
		throw new Error(
			"useChatHistoryContext must be used within ChatHistoryProvider"
		);
	}
	return ctx;
}

/** The context when a provider is mounted, else null (proof harnesses render
 * sidebar rows on their own). */
export function useOptionalChatHistoryContext() {
	return useContext(ChatHistoryContext);
}

const NO_RUNNING_MAIN_THREADS: ReadonlySet<string> = new Set();

/**
 * Ids of main threads with at least one running session. Sessions are hidden
 * behind their main thread in the sidebar, so the main thread's row carries
 * their live state. Empty without a provider.
 */
export function useRunningMainThreadIds(): ReadonlySet<string> {
	const conversations = useContext(ChatHistoryContext)?.conversations;
	return useMemo(() => {
		if (!conversations) {
			return NO_RUNNING_MAIN_THREADS;
		}
		const ids = new Set<string>();
		for (const conversation of conversations) {
			const parent = conversation.hierarchy?.spawnedByConversationId;
			if (parent && conversation.runStatus === "running") {
				ids.add(parent);
			}
		}
		return ids.size ? ids : NO_RUNNING_MAIN_THREADS;
	}, [conversations]);
}

/**
 * Whether the conversation list asks Core for message previews: while the
 * messaging row style or sidebar previews are on, and for the rest of the
 * session once a workspace interface has been shown (the latch, not the live
 * flag, so mounting and unmounting an interface does not refetch the list).
 */
export function useWantConversationPreview(): boolean {
	const [sidebarChatPreview] = useSidebarChatPreview();
	const messagingRows = useMessagingRows();
	// A selected workspace interface asks from the first list fetch, before
	// its surface has mounted and set the latch.
	const interfaceSurfaceSelected = useInterfaceSurfaceSelected();
	const interfaceLatched = useInterfaceActive((state) => state.previewLatched);
	return (
		messagingRows ||
		sidebarChatPreview ||
		interfaceSurfaceSelected ||
		interfaceLatched
	);
}

// Server-side shape returned by Core's `GET /api/conversations`.
export interface CoreConversationSummary {
	agent_id: string | null;
	archived?: boolean;
	branch: string | null;
	/** RNP handoff marker; parsed by {@link parseContinuedOn}. */
	continued_on?: unknown;
	// Projects › Bots/Groups › Sessions hierarchy (flattened by Core).
	coordination?: string;
	created_at: number;
	folder_path: string | null;
	icon?: GlyphValue;
	id: string;
	/** Only present when the list was fetched with `?preview=1`. */
	last_message?: string;
	last_message_at?: number;
	last_message_role?: string;
	linked_pull_requests?: string[];
	message_count: number;
	owner_id?: string;
	owner_kind?: string;
	participants?: string[];
	pinned?: boolean;
	project_id?: string;
	run_status: string | null;
	spawned_by_conversation_id?: string;
	spawned_by_message_id?: string;
	thread_role?: string;
	title: string | null;
	updated_at: number;
	visibility?: string;
	worktree_path: string | null;
}

// Server-side shape returned by Core's `GET /api/conversations/:id`.
interface CoreMessage {
	author_name?: string | null;
	author_user_id?: string | null;
	content: string;
	created_at: number;
	id: string;
	/** Set by Core's boot reconciliation on an assistant turn the node died in
	 * the middle of — its text/parts are whatever had been flushed. */
	interrupted?: boolean;
	metadata?: Record<string, RyuJsonValue>;
	origin_server?: string | null;
	parent_message_id?: string;
	/**
	 * Structured render parts (AI SDK reduced UIMessage `parts` array) captured
	 * server-side as an assistant turn streamed. Present only for assistant turns
	 * that ran tools/media after parts capture existed; absent otherwise (the
	 * client falls back to a text part from `content`).
	 */
	parts?: unknown[];
	persisted?: boolean;
	role: string;
	sibling_count?: number;
	sibling_ids?: string[];
	/** Version-tree fields from Core's active-path read. */
	sibling_index?: number;
	source?: string | null;
	widget_instance_id?: string | null;
}

interface CoreConversationPage {
	has_older_messages?: boolean;
	messages?: CoreMessage[];
	older_messages_cursor?: string | null;
}

const CHAT_HISTORY_PAGE_SIZE = 40;
// How long a hover/focus prefetch of a conversation's newest page stays usable.
const HISTORY_PREFETCH_TTL_MS = 10_000;

async function validatedMessageParts(
	message: CoreMessage
): Promise<UIMessage["parts"] | undefined> {
	if (!(Array.isArray(message.parts) && message.parts.length > 0)) {
		return undefined;
	}
	const result = await safeValidateUIMessages({
		messages: [
			{
				id: message.id,
				parts: message.parts,
				role: message.role === "assistant" ? "assistant" : "user",
			},
		],
	});
	return result.success ? result.data[0]?.parts : undefined;
}

async function mapCoreMessages(
	messages: CoreMessage[] | undefined
): Promise<Message[]> {
	return await Promise.all(
		(messages ?? []).map(async (m) => ({
			author:
				isNativeText(m.author_user_id) && m.author_user_id.trim()
					? {
							id: m.author_user_id,
							name:
								isNativeText(m.author_name) && m.author_name.trim()
									? m.author_name
									: undefined,
						}
					: undefined,
			id: m.id,
			// Every row returned by this history endpoint is already durable. Core's
			// wire shape predates the client-only marker, so do not wait for an
			// optional field that older nodes never send.
			persisted: true,
			role: m.role === "assistant" ? "assistant" : "user",
			content: m.content,
			metadata: jsonResponseDocumentSchema.safeParse(m.metadata).data,
			originServer: isNativeText(m.origin_server) ? m.origin_server : undefined,
			source: m.source ?? undefined,
			// Carry through the structured parts when Core has them, so the
			// chat page can rehydrate tool rows + cowork context instead of
			// only flat text (see ChatPage's hydration).
			parts: await validatedMessageParts(m),
			interrupted: m.interrupted === true,
			siblingIndex: m.sibling_index,
			siblingCount: m.sibling_count,
			siblingIds: m.sibling_ids,
			parentMessageId: m.parent_message_id,
			timestamp: m.created_at,
			widgetInstanceId: isNativeText(m.widget_instance_id)
				? m.widget_instance_id
				: undefined,
		}))
	);
}

function coreFetch(
	url: string,
	token: string | null | undefined,
	path: string,
	options?: AuthenticatedFetchOptions,
	userJwt?: string | null
): Promise<Response> {
	return authenticatedFetch(
		{ url, token: token ?? null, userJwt: userJwt ?? null },
		path,
		options
	);
}

/** The title a conversation carries until it has been named — the only string
 * `seedTitleFromFirstMessage` is allowed to overwrite. */
const UNTITLED = "New Chat";
/** Longest derived title, in characters. Matches Core's `derive_title` cap. */
const DERIVED_TITLE_MAX = 60;

/**
 * Mirror of Core's `derive_title` (apps/core/src/server/conversations.rs): the
 * first line of the message, capped at 60 characters with an ellipsis. Core runs
 * the same rule when it persists the turn; doing it client-side too is what makes
 * the sidebar row read as the message *immediately* instead of after the reply
 * lands. The two must stay byte-identical or the title visibly changes under the
 * user when the list refreshes.
 *
 * Returns null for a text-less message (an image- or file-only opener), matching
 * Core's `None` — better an honest placeholder than a title of "".
 */
function deriveDraftTitle(content: string): string | null {
	const firstLine = content.trim().split("\n")[0]?.trim() ?? "";
	if (!firstLine) {
		return null;
	}
	const chars = [...firstLine];
	return chars.length <= DERIVED_TITLE_MAX
		? firstLine
		: `${chars.slice(0, DERIVED_TITLE_MAX).join("")}…`;
}

export function summaryToConversation(
	summary: CoreConversationSummary
): Conversation {
	return {
		id: summary.id,
		title: summary.title ?? UNTITLED,
		agentId: summary.agent_id ?? undefined,
		participants: summary.participants?.length
			? summary.participants
			: undefined,
		messages: [],
		createdAt: summary.created_at,
		updatedAt: summary.updated_at,
		folderPath: summary.folder_path ?? undefined,
		branch: summary.branch ?? undefined,
		worktreePath: summary.worktree_path ?? undefined,
		runStatus: summary.run_status ?? undefined,
		pinned: summary.pinned ?? false,
		archived: summary.archived ?? false,
		icon: summary.icon ?? null,
		lastMessage: summary.last_message,
		lastMessageRole: summary.last_message_role,
		lastMessageAt: summary.last_message_at,
		linkedPullRequests: summary.linked_pull_requests?.length
			? summary.linked_pull_requests
			: undefined,
		messageCount: summary.message_count,
		visibility: toResourceVisibility(summary.visibility),
		hierarchy: summaryToHierarchy(summary),
		continuedOn: parseContinuedOn(summary.continued_on),
	};
}

function summaryToHierarchy(summary: CoreConversationSummary): ThreadHierarchy {
	const ownerKind = summary.owner_kind;
	return {
		role: summary.thread_role === "main" ? "main" : "session",
		projectId: summary.project_id || undefined,
		ownerKind:
			ownerKind === "agent" || ownerKind === "group" || ownerKind === "project"
				? ownerKind
				: undefined,
		ownerId: summary.owner_id || undefined,
		coordination: summary.coordination || undefined,
		spawnedByConversationId: summary.spawned_by_conversation_id || undefined,
		spawnedByMessageId: summary.spawned_by_message_id || undefined,
	};
}

export function ChatHistoryProvider({
	children,
	node,
}: {
	children: ReactNode;
	/** Pin this provider to one node (a tab bound to another computer). Absent:
	 *  the app-wide default node. */
	node?: Node;
}) {
	const storeNode = useNodeStore((s) => s.getActiveNode());
	const activeNode = node ?? storeNode;
	// Ownership includes delegated credentials, even when two selections share a URL.
	const scope = useRef({
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
		generation: 0,
	});
	if (
		scope.current.url !== activeNode.url ||
		scope.current.token !== (activeNode.token ?? null) ||
		scope.current.userJwt !== (activeNode.userJwt ?? null)
	) {
		scope.current = {
			url: activeNode.url,
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
			generation: scope.current.generation + 1,
		};
	}
	const generation = scope.current.generation;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const ownsAuthority = useCallback(
		() => mounted.current && scope.current.generation === generation,
		[generation]
	);
	const [conversations, setConversationsState] = useState<Conversation[]>([]);
	const localDraftIds = useRef(new Set<string>());
	const setConversations = useCallback(
		(update: SetStateAction<Conversation[]>) => {
			if (!ownsAuthority()) {
				return;
			}
			setConversationsState((previous) =>
				ownsAuthority()
					? typeof update === "function"
						? update(previous)
						: update
					: previous
			);
		},
		[ownsAuthority]
	);
	// Seeded `true`, not `false`: the very first render happens before `refresh`
	// has even been called, and a list that reports "not loading, zero chats" in
	// that window is what makes a booting app look like a fresh install.
	const [conversationsLoading, setConversationsLoading] = useState(true);
	const [conversationsLoadFailed, setConversationsLoadFailed] = useState(false);
	const [activeConversationId, setActiveConversationIdState] = useState<
		string | null
	>(null);

	const setActiveConversationId = useCallback(
		(id: string | null) => {
			if (ownsAuthority()) {
				setActiveConversationIdState(id);
			}
		},
		[ownsAuthority]
	);

	// Message previews are the second line of the messaging-style sidebar rows.
	// They cost Core a subquery + a decrypt per conversation, so the list is only
	// asked for them while that row style is switched on — flipping the pref
	// re-runs this effect and the previews arrive (or stop) on the next tick.
	// A workspace interface needs them too: its snapshot reads
	// `lastMessage`/`lastMessageRole` for excerpts and waiting/quiet status.
	const wantPreview = useWantConversationPreview();

	const fetchConversationList = useCallback(() => {
		if (!ownsAuthority()) {
			return Promise.resolve();
		}
		const { url, token, userJwt } = activeNode;
		const query = wantPreview ? "?preview=1" : "";
		setConversationsLoading(true);
		return coreFetch(
			url,
			token,
			`/api/conversations${query}`,
			undefined,
			userJwt
		)
			.then((res) =>
				res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
			)
			.then((data: { conversations?: CoreConversationSummary[] }) => {
				if (!ownsAuthority()) {
					return;
				}
				setConversationsLoadFailed(false);
				const fromCore = (data.conversations ?? []).map(summaryToConversation);
				// Keep any local draft conversations that have not been persisted yet.
				setConversations((prev) => {
					const coreIds = new Set(fromCore.map((c) => c.id));
					for (const id of coreIds) {
						localDraftIds.current.delete(id);
					}
					const drafts = prev.filter(
						(c) => localDraftIds.current.has(c.id) && !coreIds.has(c.id)
					);
					// A Core row replaces its local copy wholesale, so a row Core has
					// not titled yet would drag a locally seeded title back to the
					// placeholder — the sidebar would show the user's message on send
					// and then revert. Core normally derives the same title from the
					// first user message, but any route that persists a turn without
					// text (or without reaching that path) leaves the column NULL, and
					// a title must never travel backwards. So: an untitled row inherits
					// whatever name it already had on screen.
					const localTitles = new Map(
						prev.filter((c) => c.title !== UNTITLED).map((c) => [c.id, c.title])
					);
					// SAFETY: localTitles is this synchronous callback's fresh Map of full conversation string titles. The same c.id is checked with has immediately before get, and neither the map nor captured conversation id is mutated in this mapper.
					const merged = fromCore.map((c) =>
						c.title === UNTITLED && localTitles.has(c.id)
							? { ...c, title: localTitles.get(c.id) as string }
							: c
					);
					return [...drafts, ...merged];
				});
			})
			.catch(() => {
				// Core may be offline; keep whatever is in memory.
				if (ownsAuthority()) {
					setConversationsLoadFailed(true);
				}
			})
			.finally(() => {
				if (ownsAuthority()) {
					setConversationsLoading(false);
				}
			});
	}, [activeNode, wantPreview, ownsAuthority, setConversations]);

	// Every chat tab refreshes the list when its turn settles, so parallel threads
	// finishing together would each refetch the whole list (a per-row message count
	// and title decrypt in Core). Coalesced: a burst of calls costs at most two
	// fetches, and the last one still sees every change. A different authority
	// owns a fresh queue so its initial read cannot wait behind the previous node.
	const fetchConversationListRef = useRef(fetchConversationList);
	fetchConversationListRef.current = fetchConversationList;
	const refresh = useMemo(
		() =>
			coalesceCalls(() =>
				ownsAuthority() ? fetchConversationListRef.current() : Promise.resolve()
			),
		[ownsAuthority]
	);

	// A node switch or a preview toggle changes what the list must contain;
	// `fetchConversationList` is listed as the trigger, and `refresh` reads the
	// current one through the ref.
	useEffect(() => {
		refresh();
	}, [fetchConversationList, refresh]);

	// Auto-recover the conversation list when Core reconnects or the user hits
	// "Refresh all" — no manual "Try again" in the sidebar history.
	useCoreRefresh(refresh);

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

	const getConversation = useCallback(
		(id: string) => conversations.find((c) => c.id === id),
		[conversations]
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

	const listConversations = useCallback(
		() => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
		[conversations]
	);

	const loadMessagesResult = useCallback(
		async (id: string): Promise<LoadMessagesResult> => {
			if (!ownsAuthority()) {
				return { messages: [], status: "error" };
			}
			const { url, token, userJwt } = activeNode;
			try {
				const res = await coreFetch(
					url,
					token,
					`/api/conversations/${encodeURIComponent(id)}`,
					undefined,
					userJwt
				);
				// 404 is an ANSWER, not a failure: the node is up and says this
				// conversation is gone (deleted, or never persisted). That is the
				// "does not exist" state, which correctly falls through to the
				// new-chat surface — unlike an unreachable node, which must not.
				if (!ownsAuthority()) {
					return { messages: [], status: "error" };
				}
				if (res.status === 404) {
					return { status: "ok", messages: [] };
				}
				if (!res.ok) {
					return { status: "error", messages: [] };
				}
				const data: { messages?: CoreMessage[] } = await res.json();
				const messages = await mapCoreMessages(data.messages);
				if (!ownsAuthority()) {
					return { messages: [], status: "error" };
				}
				return {
					status: "ok",
					messages,
				};
			} catch {
				return { status: "error", messages: [] };
			}
		},
		[activeNode, ownsAuthority]
	);

	const fetchMessagesPage = useCallback(
		async (id: string, before?: string): Promise<LoadMessagesResult> => {
			if (!ownsAuthority()) {
				return { messages: [], status: "error" };
			}
			const { url, token, userJwt } = activeNode;
			const query = new URLSearchParams({
				limit: String(CHAT_HISTORY_PAGE_SIZE),
			});
			if (before) {
				query.set("before", before);
			}
			try {
				const res = await coreFetch(
					url,
					token,
					`/api/conversations/${encodeURIComponent(id)}?${query.toString()}`,
					undefined,
					userJwt
				);
				if (!ownsAuthority()) {
					return { messages: [], status: "error" };
				}
				if (res.status === 404) {
					return {
						hasOlderMessages: false,
						messages: [],
						status: "ok",
					};
				}
				if (!res.ok) {
					return { messages: [], status: "error" };
				}
				const data: CoreConversationPage = await res.json();
				const messages = await mapCoreMessages(data.messages);
				if (!ownsAuthority()) {
					return { messages: [], status: "error" };
				}
				return {
					hasOlderMessages: data.has_older_messages === true,
					messages,
					olderMessagesCursor: isNativeText(data.older_messages_cursor)
						? data.older_messages_cursor
						: undefined,
					status: "ok",
				};
			} catch {
				return { messages: [], status: "error" };
			}
		},
		[activeNode, ownsAuthority]
	);

	// Newest-page fetches started on hover/focus, keyed by node and conversation.
	// The conversation's `updatedAt` is the version: a turn landing between the
	// hover and the open makes the prefetched page stale, so it is not used.
	const prefetchedPages = useRef(
		createPrefetchCache<LoadMessagesResult>(HISTORY_PREFETCH_TTL_MS)
	);
	// Clear node-owned history before paint without remounting the workspace.
	useLayoutEffect(() => {
		if (generation === 0) {
			return;
		}
		setConversationsState([]);
		localDraftIds.current.clear();
		setConversationsLoading(true);
		setConversationsLoadFailed(false);
		setActiveConversationIdState(null);
		prefetchedPages.current = createPrefetchCache<LoadMessagesResult>(
			HISTORY_PREFETCH_TTL_MS
		);
	}, [generation]);
	const conversationsRef = useRef(conversations);
	conversationsRef.current = conversations;
	const conversationVersion = useCallback(
		(id: string) =>
			conversationsRef.current.find((c) => c.id === id)?.updatedAt,
		[]
	);

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

	const prefetchConversation = useCallback(
		(id: string) => {
			if (!ownsAuthority()) {
				return;
			}
			prefetchedPages.current.start(
				`${activeNode.url}\n${id}`,
				conversationVersion(id),
				() => fetchMessagesPage(id)
			);
		},
		[activeNode.url, conversationVersion, fetchMessagesPage, ownsAuthority]
	);

	const loadMessagesPageResult = useCallback(
		async (
			id: string,
			before?: string,
			options?: { fresh?: boolean }
		): Promise<LoadMessagesResult> => {
			if (!ownsAuthority()) {
				return { messages: [], status: "error" };
			}
			// `fresh` skips a hover prefetch: a running thread changes under the
			// same conversation version, so only a new read is current.
			const prefetched =
				before || options?.fresh
					? undefined
					: prefetchedPages.current.take(
							`${activeNode.url}\n${id}`,
							conversationVersion(id)
						);
			const result = await prefetched;
			if (!ownsAuthority()) {
				return { messages: [], status: "error" };
			}
			// A failed prefetch is retried rather than reported: Core may simply
			// not have been ready when the pointer passed over the row.
			if (result?.status === "ok") {
				return result;
			}
			return fetchMessagesPage(id, before);
		},
		[activeNode.url, conversationVersion, fetchMessagesPage, ownsAuthority]
	);

	const loadMessages = useCallback(
		async (id: string): Promise<Message[]> => {
			const { messages } = await loadMessagesResult(id);
			return messages;
		},
		[loadMessagesResult]
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

	const value: ChatHistoryContextValue = useMemo(
		() => ({
			conversations,
			conversationsLoading,
			conversationsLoadFailed,
			activeConversationId,
			createConversation,
			getConversation,
			deleteConversation,
			autoRenameConversation,
			renameConversation,
			setConversationFolder,
			moveConversationToProject,
			removeConversationFromProject,
			setConversationGlyph,
			setConversationPullRequestLinked,
			setConversationVisibility,
			setActiveConversationId,
			listConversations,
			loadMessages,
			loadMessagesResult,
			loadMessagesPageResult,
			prefetchConversation,
			forkConversation,
			editMessage,
			regenerateMessage,
			selectVersion,
			seedTitleFromFirstMessage,
			refresh,
		}),
		[
			conversations,
			conversationsLoading,
			conversationsLoadFailed,
			activeConversationId,
			setActiveConversationId,
			createConversation,
			getConversation,
			deleteConversation,
			autoRenameConversation,
			renameConversation,
			setConversationFolder,
			moveConversationToProject,
			removeConversationFromProject,
			setConversationGlyph,
			setConversationPullRequestLinked,
			setConversationVisibility,
			listConversations,
			loadMessages,
			loadMessagesResult,
			loadMessagesPageResult,
			prefetchConversation,
			forkConversation,
			editMessage,
			regenerateMessage,
			selectVersion,
			seedTitleFromFirstMessage,
			refresh,
		]
	);

	return (
		<ChatHistoryContext.Provider value={value}>
			{children}
		</ChatHistoryContext.Provider>
	);
}
