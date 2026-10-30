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
import { coalesceCalls } from "@/src/lib/coalesce-calls.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import { createPrefetchCache } from "@/src/lib/prefetch-cache.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	type CoreConversationSummary,
	coreFetch,
	HISTORY_PREFETCH_TTL_MS,
	summaryToConversation,
	UNTITLED,
} from "./chat-history/core-conversation.ts";
import type {
	ChatHistoryContextValue,
	LoadMessagesResult,
} from "./chat-history/types.ts";
import { useConversationActions } from "./chat-history/use-conversation-actions.ts";
import { useConversationMessages } from "./chat-history/use-conversation-messages.ts";
import { useConversationMutations } from "./chat-history/use-conversation-mutations.ts";

// Core's wire shapes, the mapping and the provider's hooks live under
// `./chat-history/`; this module keeps the public import path.
export type { CoreConversationSummary } from "./chat-history/core-conversation.ts";
export { summaryToConversation } from "./chat-history/core-conversation.ts";

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

/** Main-thread ids with a running session, computed once per list change by
 *  the provider so sidebar rows read a shared set instead of each scanning the
 *  whole conversation list. */
const RunningMainThreadsContext = createContext<ReadonlySet<string>>(
	NO_RUNNING_MAIN_THREADS
);

function runningMainThreadIdsOf(
	conversations: readonly Conversation[]
): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const conversation of conversations) {
		const parent = conversation.hierarchy?.spawnedByConversationId;
		if (parent && conversation.runStatus === "running") {
			ids.add(parent);
		}
	}
	return ids.size ? ids : NO_RUNNING_MAIN_THREADS;
}

/** The chat-history callbacks a sidebar row calls. They are stable, so rows
 *  that read them here do not re-render on every list or title change the way
 *  the full context value would make them. */
export type ChatHistoryRowActions = Pick<
	ChatHistoryContextValue,
	"prefetchConversation" | "refresh" | "setConversationPullRequestLinked"
>;

const ChatHistoryRowActionsContext =
	createContext<ChatHistoryRowActions | null>(null);

/** The row callbacks when a provider is mounted, else null. */
export function useChatHistoryRowActions(): ChatHistoryRowActions | null {
	return useContext(ChatHistoryRowActionsContext);
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const id of a) {
		if (!b.has(id)) {
			return false;
		}
	}
	return true;
}

/**
 * Ids of main threads with at least one running session. Sessions are hidden
 * behind their main thread in the sidebar, so the main thread's row carries
 * their live state. Empty without a provider.
 */
export function useRunningMainThreadIds(): ReadonlySet<string> {
	return useContext(RunningMainThreadsContext);
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
	const {
		autoRenameConversation,
		createConversation,
		deleteConversation,
		renameConversation,
		seedTitleFromFirstMessage,
		setConversationFolder,
		setConversationGlyph,
		setConversationPullRequestLinked,
		setConversationVisibility,
	} = useConversationMutations({
		activeNode,
		conversations,
		localDraftIds,
		ownsAuthority,
		refresh,
		setConversations,
	});

	const getConversation = useCallback(
		(id: string) => conversations.find((c) => c.id === id),
		[conversations]
	);

	const listConversations = useCallback(
		() => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
		[conversations]
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

	const {
		loadMessages,
		loadMessagesPageResult,
		loadMessagesResult,
		prefetchConversation,
	} = useConversationMessages({
		activeNode,
		conversationVersion,
		ownsAuthority,
		prefetchedPages,
	});
	const {
		editMessage,
		forkConversation,
		moveConversationToProject,
		regenerateMessage,
		removeConversationFromProject,
		selectVersion,
	} = useConversationActions({
		activeNode,
		conversationsRef,
		ownsAuthority,
		setConversations,
	});

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

	const rowActions = useMemo<ChatHistoryRowActions>(
		() => ({ prefetchConversation, refresh, setConversationPullRequestLinked }),
		[prefetchConversation, refresh, setConversationPullRequestLinked]
	);

	// Keep the previous set while its ids are unchanged: a title or preview
	// update rebuilds `conversations`, and a fresh set would re-render every row.
	const runningMainThreadIdsRef = useRef(NO_RUNNING_MAIN_THREADS);
	const runningMainThreadIds = useMemo(() => {
		const next = runningMainThreadIdsOf(conversations);
		if (sameIds(next, runningMainThreadIdsRef.current)) {
			return runningMainThreadIdsRef.current;
		}
		runningMainThreadIdsRef.current = next;
		return next;
	}, [conversations]);

	return (
		<ChatHistoryContext.Provider value={value}>
			<ChatHistoryRowActionsContext.Provider value={rowActions}>
				<RunningMainThreadsContext.Provider value={runningMainThreadIds}>
					{children}
				</RunningMainThreadsContext.Provider>
			</ChatHistoryRowActionsContext.Provider>
		</ChatHistoryContext.Provider>
	);
}
