import { Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	ArtifactHostValue,
	NativeArtifactObservation,
} from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useMemo, useRef } from "react";
import { ChatTitlebarOverflow } from "@/src/components/chat/ChatTitlebarOverflow.tsx";
import { InlineArtifact } from "@/src/components/chat/InlineArtifact.tsx";
import { PanelToggleButtons } from "@/src/components/panels/WorkspacePanels.tsx";
import { useTitleBar } from "@/src/contexts/TitleBarContext.tsx";
import {
	copyChatTranscript,
	type TranscriptMessage,
} from "@/src/lib/copy-chat-transcript.ts";
import {
	type ArtifactView,
	artifactFromSdkObservation,
} from "@/src/lib/live-artifacts.ts";
import type { NativeArtifactContentFetchOperation } from "@/src/lib/native-artifact-io-abi.ts";
import { planArtifact } from "@/src/lib/plan-artifacts.ts";
import { useArtifactStore } from "@/src/store/useArtifactStore.ts";
import type { useChatAnswerNow } from "./ChatPage.answer-now.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerControls } from "./ChatPage.composer-controls.tsx";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatDraftsAndRewind } from "./ChatPage.drafts-rewind.ts";
import { fetchArtifactContent } from "./ChatPage.helpers.ts";
import { useLiveSlot } from "./ChatPage.live-slot.tsx";
import type { useChatMessagePipeline } from "./ChatPage.message-pipeline.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPanelRequests } from "./ChatPage.panel-requests.ts";
import type { useChatPlans } from "./ChatPage.plans.tsx";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatRealtimeRoom } from "./ChatPage.realtime-room.ts";
import type { useChatSideChats } from "./ChatPage.side-chats.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatTitlebarInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatAnswerNow> &
	ReturnType<typeof useChatRealtimeRoom> &
	ReturnType<typeof useChatSideChats> &
	ReturnType<typeof useChatPanelRequests> &
	ReturnType<typeof useChatDraftsAndRewind> &
	ReturnType<typeof useChatMessagePipeline> &
	ReturnType<typeof useChatComposerControls> &
	ReturnType<typeof useChatPlans>;

/** Artifacts, the pinned summary, title bar actions, and the history error copy. */
export function useChatTitlebar({
	planSnapshots,
	savedPlanDocuments,
	planSaveErrors,
	hasMessages,
	pinnedSummaryOpen,
	convId,
	getConversation,
	messages,
	chatTarget,
	effectiveStatus,
	handleOpenArtifact,
	handleOpenSideChat,
	handleOpenSubagent,
	handleOpenSources,
	handleOpenSubagents,
	sideChatsRefreshKey,
	sideChatsPluginEnabled,
	openTab,
	handleComposerSubmit,
	ghostChatActive,
	chatContextPanelRef,
	activeConversationId,
	draftConvId,
	selectedAgent,
	teamId,
	handleOpenAgentActivity,
	hasThread,
	agentTools,
	processedMessages,
	readLatestProcessedMessages,
	oidcUser,
	setShareDialogOpen,
	chatPickerPlacement,
	composerPicker,
	bottomPanelShown,
	chatFolder,
	toggleBottomPanel,
	setPinnedSummaryOpen,
	toggleRightPanel,
	rightPanelShown,
	showBottomPanelToggle,
	connectionPhase,
}: UseChatTitlebarInput) {
	const planArtifacts = useMemo(
		() =>
			planSnapshots.map((plan) =>
				planArtifact(
					plan,
					savedPlanDocuments[plan.key],
					planSaveErrors[plan.key]
				)
			),
		[planSaveErrors, planSnapshots, savedPlanDocuments]
	);

	// The Pinned summary sidebar shows only on a history page. It stacks with
	// the right panel (both docked columns can be open at once) — visibility is
	// just the user's titlebar toggle (`pinnedSummaryOpen`).
	const pinnedSummaryVisible = hasMessages && pinnedSummaryOpen;
	const pinnedSummaryFolder = convId
		? (getConversation(convId)?.folderPath ?? null)
		: null;

	// The Cowork context (Progress / Artifacts / Changes / Sources / Side chats),
	// shared by the right panel's Context tab and the floating Pinned summary card.
	const coworkData = {
		messages,
		runId: convId,
		target: chatTarget,
		chatStatus: effectiveStatus,
		planArtifacts,
		onOpenArtifact: handleOpenArtifact,
		onOpenSideChat: handleOpenSideChat,
		onOpenSubagent: handleOpenSubagent,
		onOpenSources: handleOpenSources,
		onOpenSubagents: handleOpenSubagents,
		sideChatsRefreshKey,
		sideChatsEnabled: sideChatsPluginEnabled,
	};

	// The desktop half of the artifact host: `@ryu/blocks` renders an inline
	// artifact card through this context (openInPanel / openInTab / fetchContent /
	// submitFollowUp), and the Renderer is our InlineArtifact card. `openInTab`
	// resolves a created artifact's blob BEFORE the tab opens so the window-tab
	// page (which has no host) renders content rather than an empty view.
	const artifactHostValue = useMemo<ArtifactHostValue>(() => {
		const openArtifactTab = (
			payload: NativeArtifactObservation,
			id: string
		) => {
			const artifact = artifactFromSdkObservation(payload, id, "tool");
			const openTabNow = (resolved: ArtifactView) => {
				useArtifactStore.getState().put(resolved);
				openTab(`/artifact/${id}`, {
					title: resolved.title,
					icon: { kind: "icon", id: "hugeicons:browser" },
				});
			};
			if (!artifact.content && artifact.url) {
				// SAFETY: the actual private I/O function receives the raw SDK slot through
				// its native argument ABI; URL coercion/errors remain inside its unchanged
				// catch. Function resolution precedes the original raw argument read.
				Promise.resolve(
					(fetchArtifactContent as NativeArtifactContentFetchOperation)(
						chatTarget,
						artifact.url
					)
				)
					.then((content) =>
						openTabNow(content ? { ...artifact, content } : artifact)
					)
					.catch(() => openTabNow(artifact));
				return;
			}
			openTabNow(artifact);
		};
		return {
			openInPanel: (payload, id) =>
				handleOpenArtifact(artifactFromSdkObservation(payload, id, "tool")),
			openInTab: openArtifactTab,
			fetchContent: (payload) =>
				payload.url
					? // SAFETY: same actual I/O function/raw argument ABI; no URL/string DTO
						// claim or early parsing changes its own native catch/error phase.
						/* SAFETY: same actual I/O function forwarding ABI; raw argument reaches its unchanged native catch. */ (
							fetchArtifactContent as NativeArtifactContentFetchOperation
						)(chatTarget, payload.url)
					: Promise.resolve(null),
			submitFollowUp: (text) => {
				Promise.resolve(
					handleComposerSubmit({ role: "user", content: text })
				).catch(() => undefined);
			},
			Renderer: InlineArtifact,
		};
	}, [chatTarget, handleOpenArtifact, openTab, handleComposerSubmit]);

	// A ghost thread has no store-backed title (it's never persisted), so label it
	// "Temporary chat" to reinforce that this conversation won't be saved.
	// THIS TAB's conversation names it: on a new chat tab's first render the
	// shared focused-tab `activeConversationId` still holds the previously focused
	// conversation, and the tab strip kept that conversation's title.
	const persistedTitle = convId ? getConversation(convId)?.title : undefined;
	const conversationTitle = ghostChatActive
		? "Temporary chat"
		: (persistedTitle ?? "New chat");
	chatContextPanelRef.current = {
		conversation: {
			id: activeConversationId ?? draftConvId.current,
			title: conversationTitle,
		},
		id: "context",
		label: "Context",
		region: "right",
	};

	// The transcript is read on demand (the newest streamed text included) so the
	// header actions do not rebuild and re-push to the shared titlebar as the
	// conversation changes; only whether the chat has messages matters to them.
	const readTranscriptRef = useRef(readLatestProcessedMessages);
	readTranscriptRef.current = readLatestProcessedMessages;
	const copyUserNameRef = useRef<string | undefined>(undefined);
	copyUserNameRef.current = oidcUser?.name || oidcUser?.email;

	// Push the conversation title and contextual actions into the shared titlebar.
	// The header shows at most Share, the right-panel toggle and `⋯`; copy,
	// agent activity, tools, the pinned summary and the bottom panel live in the
	// overflow menu. Actions are memoized so the effect only re-fires when the
	// relevant state changes.
	// The picker element is rebuilt on every ChatPage render, so it reaches the
	// actions through a live slot: the slot re-renders with each new picker while
	// the actions keep their identity and are not pushed to the title bar again.
	const tabBarPicker =
		chatPickerPlacement === "tab-bar" ? composerPicker : null;
	const hasTabBarPicker = Boolean(tabBarPicker);
	const tabBarPickerSlot = useLiveSlot(tabBarPicker);
	const titlebarActions = useMemo(() => {
		const shareAction =
			hasMessages && activeConversationId && !ghostChatActive ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label="Share conversation"
								onClick={() => setShareDialogOpen(true)}
								size="icon-sm"
								type="button"
								variant="ghost-muted"
							>
								<HugeiconsIcon className="size-4" icon={Share08Icon} />
							</Button>
						}
					/>
					<TooltipContent>Share conversation</TooltipContent>
				</Tooltip>
			) : null;

		const pickerAction = hasTabBarPicker ? (
			<span
				className="flex min-w-0 items-center"
				data-testid="chat-model-agent-picker-tab-bar"
			>
				{tabBarPickerSlot}
			</span>
		) : null;

		return (
			<>
				{pickerAction}
				{shareAction}
				<PanelToggleButtons
					bottomOpen={bottomPanelShown}
					folder={chatFolder}
					onBottomToggle={toggleBottomPanel}
					onRightToggle={toggleRightPanel}
					rightOpen={rightPanelShown}
					showBottomPanelToggle={false}
				/>
				<ChatTitlebarOverflow
					agentTools={hasThread ? agentTools : []}
					bottomPanelOpen={bottomPanelShown}
					onCopyTranscript={
						hasMessages
							? () => {
									void copyChatTranscript(
										/* SAFETY: The SDK messages already have string roles and native parts; copyChatTranscript validates text parts with its own Zod projection. */ readTranscriptRef.current() as TranscriptMessage[],
										{ defaultUserName: copyUserNameRef.current }
									);
								}
							: undefined
					}
					// Agent selection remains in the composer. This opens the selected
					// agent's own activity and identity in the right dock.
					onOpenAgentActivity={
						selectedAgent && !teamId ? handleOpenAgentActivity : undefined
					}
					onToggleBottomPanel={
						showBottomPanelToggle ? toggleBottomPanel : undefined
					}
					onTogglePinnedSummary={
						hasMessages ? () => setPinnedSummaryOpen((v) => !v) : undefined
					}
					pinnedSummaryOpen={pinnedSummaryOpen}
				/>
			</>
		);
	}, [
		hasThread,
		hasMessages,
		activeConversationId,
		ghostChatActive,
		handleOpenAgentActivity,
		selectedAgent,
		teamId,
		agentTools,
		hasTabBarPicker,
		tabBarPickerSlot,
		bottomPanelShown,
		showBottomPanelToggle,
		rightPanelShown,
		toggleBottomPanel,
		toggleRightPanel,
		chatFolder,
		pinnedSummaryOpen,
	]);

	const historyErrorCopy =
		connectionPhase === "online"
			? {
					description: "The node didn't answer. Your messages are safe on it.",
					title: "Couldn't load this conversation",
				}
			: connectionPhase === "offline"
				? {
						description:
							"Ryu will retry automatically when your connection returns.",
						title: "Waiting for connectivity",
					}
				: {
						description:
							"Ryu will retry automatically when this node reconnects.",
						title: "Waiting for node",
					};

	// The tab's label is the one thing a new chat tab may already have been given:
	// Start on a suggested task opens it named for the task. `hasThread` is true on
	// that tab's first render (the focused-tab conversation id still points at the
	// thread it was started from), so the "New chat" placeholder would overwrite
	// the label at once. The label follows this tab's own thread only: once it has
	// a conversation, a message, or is temporary.
	const ownsThread =
		Boolean(convId) || processedMessages.length > 0 || ghostChatActive;
	useTitleBar(hasThread ? conversationTitle : null, titlebarActions, {
		syncTabLabel: ownsThread,
	});
	return {
		pinnedSummaryVisible,
		pinnedSummaryFolder,
		coworkData,
		artifactHostValue,
		conversationTitle,
		historyErrorCopy,
	} as const;
}
