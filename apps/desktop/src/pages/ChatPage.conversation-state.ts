import { CLOUD_TASKS_BOX_BACKEND_FLAG } from "@ryu/auth/lib/feature-flags";
import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import { useAgentUsage } from "@/src/hooks/useAgentUsage.ts";
import { useCloudTaskSelection } from "@/src/hooks/useCloudTaskSelection.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import { useMergedAgentThreads } from "@/src/hooks/useMergedAgentThreads.ts";
import {
	useConversationProviderAccount,
	useProviderAccountUsage,
} from "@/src/hooks/useProviderAccountUsage.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { deleteDraft, listDrafts, saveDraft } from "@/src/lib/api/drafts.ts";
import { usageSnapshotFromReading } from "@/src/lib/api/usage.ts";
import { cloudTaskBlockReason } from "@/src/lib/cloud-task-selection.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { ChatSearchState } from "./ChatPage.helpers.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatConversationStateInput = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatModelSelection>;

/** History, search, folder, stats, cloud task and draft state for this tab's conversation. */
export function useChatConversationState({
	convId,
	modelHistoryReady,
	modelSelectionScope,
	setModelSelectionCleared,
	setStreamedAcpControl,
	folder,
	localProjectlessTaskFolder,
	tabConversationId,
	mergedAgentId,
	setConvId,
	statsPluginEnabled,
	agentId,
	activeNode,
	draftConvId,
	baseComposerBlocked,
}: UseChatConversationStateInput) {
	const tl = useLiteralMessages();
	// `tl` is a fresh function on every render; memos and callbacks read it
	// through this ref so their identities stay stable.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const {
		activeConversationId,
		conversations,
		setActiveConversationId,
		createConversation,
		getConversation,
		loadMessages,
		loadMessagesResult,
		loadMessagesPageResult,
		forkConversation,
		editMessage,
		regenerateMessage,
		selectVersion,
		seedTitleFromFirstMessage,
		setConversationFolder,
		refresh,
	} = useChatHistoryContext();

	// Version-tree state (ChatGPT/Claude edit + regenerate branching), keyed by
	// message id: how many versions exist at this branch point, which is active,
	// and the ordered sibling ids the pager steps through. Populated from Core's
	// active-path read on every (re)hydration; empty for never-branched threads.
	const [versions, setVersions] = useState<
		Record<string, { index: number; count: number; ids: string[] }>
	>({});
	// Persisted Learning action state for the active conversation, keyed by
	// assistant message id. The Learning plugin contributes the toolbar control;
	// the shell only hydrates and optimistically mirrors its durable state.
	const [feedback, setFeedback] = useState<Record<string, "up" | "down">>({});
	// One-shot flag consumed by the chat-stream body: when a regenerate()/edit
	// re-run streams, Core must NOT re-append the trailing user turn (it is
	// already persisted). Set immediately before regenerate(), reset on read.
	const skipNextUserAppendRef = useRef(false);

	const modelSelectionLoading =
		convId !== null &&
		(modelHistoryReady?.conversationId !== convId ||
			modelHistoryReady.scope !== modelSelectionScope);
	const [chatSearch, setChatSearch] = useState<ChatSearchState>({
		mode: "chat",
		nonce: 0,
		open: false,
		query: "",
	});
	const [activeChatSearchMatchIndex, setActiveChatSearchMatchIndex] =
		useState(0);
	const fileSearchRequest = useMemo(
		() =>
			chatSearch.open && chatSearch.mode === "files"
				? { nonce: chatSearch.nonce, query: chatSearch.query }
				: null,
		[chatSearch]
	);
	useEffect(() => {
		setChatSearch((current) =>
			current.open
				? {
						...current,
						mode: "chat",
						nonce: current.nonce + 1,
						open: false,
						query: "",
					}
				: current
		);
		setActiveChatSearchMatchIndex(0);
	}, [convId]);
	// Agent-level controls are scoped to the conversation that emitted them. Do
	// not carry a model/effort override into a different thread that happens to
	// use the same agent.
	useEffect(() => {
		setModelSelectionCleared(false);
		setStreamedAcpControl(null);
	}, [convId]);
	// Existing conversations own their folder. New chats may still use the
	// optional global selection, but a loaded chat must never be retargeted when
	// another tab changes that selection.
	const chatFolder = convId
		? (getConversation(convId)?.folderPath ?? null)
		: (folder ?? localProjectlessTaskFolder);
	const chatFolderRef = useRef<string | null>(chatFolder);
	chatFolderRef.current = chatFolder;
	// Every folder the last agent turn ran in (a project may span several);
	// "Trust folder" on a workspace-trust warning trusts exactly these.
	const lastAgentFoldersRef = useRef<string[]>([]);

	// Restore state for THIS tab's thread. Seeded `true` whenever the tab is
	// restored onto an existing conversation: the first paint happens before the
	// hydration effect below has even fired, and a tab that reports "not loading,
	// no messages" in that window renders the new-chat greeting — the "all my
	// chats are gone" screen the boot bug is actually about. A fresh chat has no
	// conversation id and therefore never enters this state.
	const [historyLoading, setHistoryLoading] = useState(
		Boolean(tabConversationId)
	);
	// The fetch came back as a transport/HTTP failure. Distinct from "loaded and
	// empty" — the thread exists, this node just could not be reached.
	const [historyFailed, setHistoryFailed] = useState(false);
	// Reload nonce: bumping it re-runs the hydration effect for the Try-again
	// button without touching the auto-refresh paths.
	const [historyReloadKey, setHistoryReloadKey] = useState(0);
	// History opens on the newest page. The cursor is kept in a ref so scrolling
	// can request another page without making the transcript callback churn.
	const [hasOlderMessages, setHasOlderMessages] = useState(false);
	const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
	const olderMessagesCursorRef = useRef<string | null>(null);
	const hasOlderMessagesRef = useRef(false);
	const olderMessagesRequestRef = useRef(false);
	hasOlderMessagesRef.current = hasOlderMessages;

	// ── Merged agent view ────────────────────────────────────────────────────
	// Older threads with this agent, rendered read-only above the live one. The
	// live thread is still a single conversation driven by `useChat`; only the
	// transcript above it is stitched, so streaming, editing and branching keep
	// working unchanged on the thread the composer is pointed at.
	const merged = useMergedAgentThreads({
		agentId: mergedAgentId ?? null,
		enabled: Boolean(mergedAgentId),
		liveConversationId: convId,
	});
	// Opening the view lands on the newest thread — the messaging-app default of
	// "continue where we left off".
	//
	// The latch trips the first time a thread list EXISTS, not the first time a
	// thread is selected. The conversation list is empty until Core's first fetch
	// resolves, so a latch that only trips on success would still be armed if the
	// user hit "New thread" in that window (or on a later reconnect refresh) — and
	// would then yank them out of their empty thread into the newest one.
	const mergedSeeded = useRef(false);
	useEffect(() => {
		if (!mergedAgentId || mergedSeeded.current || merged.threads.length === 0) {
			return;
		}
		mergedSeeded.current = true;
		if (convId) {
			return;
		}
		setConvId(merged.threads[0].id);
	}, [mergedAgentId, convId, merged.threads]);

	// Mirror THIS tab's conversation into the shared context whenever it is the
	// focused tab, so the sidebar highlight + goal/fork/double-check target the
	// conversation the user is actually looking at. Tab *content* is driven by
	// the local `convId`, not this shared mirror, so background tabs never fight
	// over it (e.g. tab-strip switching shows each tab's own thread).
	const isActiveTab = useIsActiveTab();
	// Stats strip usage. When Core knows which Ryu subscription account this
	// conversation runs on, show that account's reading; otherwise the agent's.
	// `source` says how sure Core is: `active` is the account the next turn would
	// start on, not one the conversation is bound to.
	const statsActive = isActiveTab && statsPluginEnabled;
	const conversationAccount = useConversationProviderAccount(
		convId ?? null,
		statsActive
	);
	const statsAccountProviderId =
		conversationAccount?.accountId && conversationAccount.source !== "unknown"
			? conversationAccount.providerId
			: null;
	const statsAccountReading = useProviderAccountUsage(
		statsAccountProviderId,
		conversationAccount?.accountId ?? null,
		statsActive && statsAccountProviderId !== null
	);
	const agentStatsUsage = useAgentUsage(
		agentId,
		statsActive && statsAccountProviderId === null
	);
	const statsUsage = useMemo(() => {
		if (!(statsAccountProviderId && statsAccountReading)) {
			return agentStatsUsage;
		}
		const label = statsAccountReading.accountLabel ?? null;
		return {
			...usageSnapshotFromReading(statsAccountReading),
			accountLabel:
				label && conversationAccount?.source === "active"
					? tlRef.current("{label} (active account)", { label })
					: label,
		};
	}, [
		agentStatsUsage,
		conversationAccount?.source,
		statsAccountProviderId,
		statsAccountReading,
	]);
	const isActiveTabRef = useRef(isActiveTab);
	isActiveTabRef.current = isActiveTab;
	useEffect(() => {
		if (isActiveTab) {
			setActiveConversationId(convId);
		}
	}, [isActiveTab, convId, setActiveConversationId]);

	const queryClient = useQueryClient();
	const chatTarget: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	const {
		scope: cloudScope,
		selection: cloudSelection,
		retry: retryCloudSelection,
	} = useCloudTaskSelection(
		chatTarget,
		convId ?? draftConvId.current,
		Boolean(convId)
	);
	const cloudSelectionRef = useRef(cloudSelection);
	cloudSelectionRef.current = cloudSelection;
	const cloudScopeRef = useRef(cloudScope);
	cloudScopeRef.current = cloudScope;
	// Rollout gate for the Fresh cloud box backend: UI-only (Core has no per-user
	// flag source); the node's Box configuration remains the hard server gate.
	const boxBackendEnabled = useFeatureFlag(CLOUD_TASKS_BOX_BACKEND_FLAG);
	const boxBackendEnabledRef = useRef(boxBackendEnabled);
	boxBackendEnabledRef.current = boxBackendEnabled;
	const cloudBlockReason = cloudTaskBlockReason(cloudSelection, agentId, {
		boxBackendEnabled,
	});
	const composerBlocked = baseComposerBlocked || Boolean(cloudBlockReason);
	const [projectDrafts, setProjectDrafts] = useState<
		import("@ryu/blocks/desktop/agent-elements/input-bar.tsx").ComposerDraftItem[]
	>([]);
	const refreshProjectDrafts = useCallback(async () => {
		try {
			const rows = await listDrafts(chatTarget);
			setProjectDrafts(
				rows
					.filter(
						(draft) =>
							(draft.folder_path ?? undefined) === (chatFolder ?? undefined)
					)
					.map((draft) => ({
						id: draft.id,
						preview: draft.preview,
						text: draft.text,
					}))
			);
		} catch {
			setProjectDrafts([]);
		}
	}, [chatFolder, chatTarget]);
	useEffect(() => {
		void refreshProjectDrafts();
	}, [refreshProjectDrafts]);
	const draftControls = useMemo(
		() => ({
			items: projectDrafts,
			onDelete: (id: string) => {
				void deleteDraft(chatTarget, id)
					.then(refreshProjectDrafts)
					.catch(() =>
						toast.error("Could not delete draft. Please try again.")
					);
			},
			onSave: async (text: string) => {
				await saveDraft(chatTarget, {
					text,
					folder_path: chatFolder ?? undefined,
					source: "manual",
				});
				await refreshProjectDrafts();
			},
		}),
		[chatFolder, chatTarget, projectDrafts, refreshProjectDrafts]
	);
	return {
		activeConversationId,
		conversations,
		setActiveConversationId,
		createConversation,
		getConversation,
		loadMessages,
		loadMessagesResult,
		loadMessagesPageResult,
		forkConversation,
		editMessage,
		regenerateMessage,
		selectVersion,
		seedTitleFromFirstMessage,
		setConversationFolder,
		refresh,
		versions,
		setVersions,
		feedback,
		setFeedback,
		skipNextUserAppendRef,
		modelSelectionLoading,
		chatSearch,
		setChatSearch,
		activeChatSearchMatchIndex,
		setActiveChatSearchMatchIndex,
		fileSearchRequest,
		chatFolder,
		chatFolderRef,
		lastAgentFoldersRef,
		historyLoading,
		setHistoryLoading,
		historyFailed,
		setHistoryFailed,
		historyReloadKey,
		setHistoryReloadKey,
		hasOlderMessages,
		setHasOlderMessages,
		loadingOlderMessages,
		setLoadingOlderMessages,
		olderMessagesCursorRef,
		hasOlderMessagesRef,
		olderMessagesRequestRef,
		merged,
		mergedSeeded,
		isActiveTab,
		statsUsage,
		isActiveTabRef,
		queryClient,
		chatTarget,
		cloudScope,
		cloudSelection,
		retryCloudSelection,
		cloudSelectionRef,
		cloudScopeRef,
		boxBackendEnabled,
		boxBackendEnabledRef,
		cloudBlockReason,
		composerBlocked,
		refreshProjectDrafts,
		draftControls,
	} as const;
}
