import { useEffect, useMemo, useRef, useState } from "react";
import type { InputBarProps } from "@/components/agent-elements/input-bar.tsx";
import { CouncilInputBar } from "@/src/components/chat/CouncilInputBar.tsx";
import { extractSubagents } from "@/src/components/panels/CoworkContextPanel.tsx";
import {
	fetchDocument,
	fetchDocuments,
	ingestDocument,
	updateDocument,
} from "@/src/lib/api/spaces.ts";
import {
	extractPlans,
	type PlanSnapshot,
	planDocumentTitle,
} from "@/src/lib/plan-artifacts.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerControls } from "./ChatPage.composer-controls.tsx";
import type { useChatComposerRefs } from "./ChatPage.composer-refs.tsx";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import {
	ARTIFACTS_SPACE_NAME,
	type SavedPlanDocument,
} from "./ChatPage.helpers.ts";
import type { useChatHistoryLoading } from "./ChatPage.history-loading.ts";
import type { useChatMediaAndVoice } from "./ChatPage.media-voice.ts";
import type { useChatMessagePipeline } from "./ChatPage.message-pipeline.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatPresence } from "./ChatPage.presence.ts";
import type { useChatRealtimeRoom } from "./ChatPage.realtime-room.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatPlansInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatMediaAndVoice> &
	ReturnType<typeof useChatHistoryLoading> &
	ReturnType<typeof useChatRealtimeRoom> &
	ReturnType<typeof useChatPresence> &
	ReturnType<typeof useChatMessagePipeline> &
	ReturnType<typeof useChatComposerControls> &
	ReturnType<typeof useChatComposerRefs>;

/** The council input bar, subagent summaries, and plan documents. */
export function useChatPlans({
	agentsStableRef,
	teamsStableRef,
	workflowsStableRef,
	botProduct,
	commandsRef,
	chatWidgetTemplatesRef,
	composerCompactRef,
	composerSectionsRef,
	myUserIdRef,
	expandedComposerPluginEnabledRef,
	ghostChatActive,
	ghostControlsRef,
	composerControlsRef,
	mentionSourcesRef,
	handleGenerateImage,
	handleGenerateVideo,
	humanMentionNotifyRef,
	referencedConversationIdsRef,
	permissionRef,
	targetAgentIdRef,
	teamIdRef,
	handleTypingActivity,
	workflowIdRef,
	pluginComposerControlsRef,
	queueBarRef,
	temporaryChatSaveControlsRef,
	turnProgressRef,
	voiceTranscribe,
	composerBlockedRef,
	voiceMode,
	workspaceBarRef,
	activeConversationId,
	processedMessages,
	messages,
	spaces,
	modelSelectionScope,
	spacesLoading,
	spacesError,
	chatTarget,
}: UseChatPlansInput) {
	const councilInputBar = useMemo(() => {
		return function BoundCouncilInputBar(props: InputBarProps) {
			return (
				<CouncilInputBar
					{...props}
					allAgents={agentsStableRef.current}
					allTeams={teamsStableRef.current}
					allWorkflows={workflowsStableRef.current}
					availableCommands={botProduct ? [] : commandsRef.current}
					chatWidgetTemplates={botProduct ? [] : chatWidgetTemplatesRef.current}
					// Single-row compact composer once the chat has history (read from a
					// ref so the memoized slot flips without rebuilding — same pattern as
					// workspaceBar). Pairs with the right-aligned controls above.
					compact={composerCompactRef.current}
					composerSections={composerSectionsRef.current}
					currentUserId={myUserIdRef.current}
					enableQueue
					expandComposer={
						botProduct ? false : expandedComposerPluginEnabledRef.current
					}
					// A muted composer fill while a temporary chat is
					// active. `ghostMode` is a dep of this memo, so the closure value is
					// always current (no ref needed).
					ghost={botProduct ? false : ghostChatActive}
					// The "+" dropdown's Temporary-chat toggle row (read fresh from the
					// ref so gating on rendered messages stays current).
					ghostControls={botProduct ? undefined : ghostControlsRef.current}
					goalBar={botProduct ? undefined : composerControlsRef.current.goalBar}
					goalControls={
						botProduct ? undefined : composerControlsRef.current.goalControls
					}
					infoBar={botProduct ? undefined : composerControlsRef.current.infoBar}
					leftActions={composerControlsRef.current.left}
					mentionSources={mentionSourcesRef.current}
					onGenerateImage={botProduct ? undefined : handleGenerateImage}
					onGenerateVideo={botProduct ? undefined : handleGenerateVideo}
					onHumanMentions={(mentions, content) =>
						humanMentionNotifyRef.current(mentions, content)
					}
					onReferencedChats={(ids) => {
						referencedConversationIdsRef.current = ids;
					}}
					onRespondPermission={permissionRef.current.onRespond}
					onTargetAgentChange={(id) => {
						targetAgentIdRef.current = id;
					}}
					onTeamChange={(id) => {
						teamIdRef.current = id;
					}}
					onTyping={handleTypingActivity}
					onWorkflowChange={(id) => {
						workflowIdRef.current = id;
					}}
					permission={permissionRef.current.permission}
					pluginControls={
						botProduct ? undefined : pluginComposerControlsRef.current
					}
					queueBar={queueBarRef.current}
					rightActions={composerControlsRef.current.right}
					temporaryChatSaveControls={
						botProduct ? undefined : temporaryChatSaveControlsRef.current
					}
					turnProgress={turnProgressRef.current}
					voice={{
						transcribe: voiceTranscribe,
						disabled: composerBlockedRef.current,
					}}
					voiceMode={botProduct ? undefined : { onStart: voiceMode.start }}
					workspaceBar={workspaceBarRef.current}
				/>
			);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		voiceTranscribe,
		handleGenerateVideo,
		handleGenerateImage,
		voiceMode.start,
		// Rebuild the composer slot when ghost mode flips so the violet ring
		// reflects it immediately (a toggle already starts a fresh thread, so the
		// brief remount costs nothing — the textarea is cleared and unfocused).
		ghostChatActive,
		handleTypingActivity,
	]);

	const hasThread =
		activeConversationId !== null || processedMessages.length > 0;

	// "History page" = the conversation has actual messages on screen. The
	// new-chat surface (centered empty state) can still carry a focused-tab
	// `activeConversationId`, so gate the workspace-bar relocation and the pinned
	// summary strictly on rendered messages — never on the new-chat page.
	const hasMessages = processedMessages.length > 0;
	const subagentSummaries = useMemo(
		() => extractSubagents(messages),
		[messages]
	);
	const planSnapshots = useMemo(() => extractPlans(messages), [messages]);
	const artifactsSpace = useMemo(
		() =>
			spaces.find(
				(space) =>
					space.name.toLowerCase() === ARTIFACTS_SPACE_NAME.toLowerCase()
			) ?? null,
		[spaces]
	);
	const [savedPlanDocuments, setSavedPlanDocuments] = useState<
		Record<string, SavedPlanDocument>
	>({});
	const [planSaveErrors, setPlanSaveErrors] = useState<Record<string, string>>(
		{}
	);
	const planPersistenceRef = useRef<{
		contents: Map<string, string>;
		documents: Map<string, SavedPlanDocument>;
		targetKey: typeof modelSelectionScope | null;
	}>({
		contents: new Map(),
		documents: new Map(),
		targetKey: null,
	});
	const planSyncQueueRef = useRef<Promise<void>>(Promise.resolve());
	const planTargetKey = modelSelectionScope;

	useEffect(() => {
		const cache = planPersistenceRef.current;
		if (cache.targetKey === planTargetKey) {
			return;
		}
		cache.contents.clear();
		cache.documents.clear();
		cache.targetKey = planTargetKey;
		setSavedPlanDocuments({});
		setPlanSaveErrors({});
	}, [planTargetKey]);

	// Persist every completed ACP/Pi plan snapshot as a markdown page in the
	// node's seeded Artifacts Space. Stable document titles make this idempotent
	// across reloads and let another tab reuse a page that already exists.
	useEffect(() => {
		if (planSnapshots.length === 0) {
			return;
		}
		if (!(spacesLoading || artifactsSpace)) {
			const message =
				spacesError ?? "The Artifacts Space is unavailable on this node.";
			setPlanSaveErrors((previous) => {
				const next = { ...previous };
				for (const plan of planSnapshots) {
					next[plan.key] = message;
				}
				return next;
			});
			return;
		}
		if (!artifactsSpace) {
			return;
		}
		const cache = planPersistenceRef.current;
		if (cache.targetKey !== planTargetKey) {
			return;
		}
		const pendingPlans: PlanSnapshot[] = planSnapshots.filter((plan) => {
			const cacheKey = `${artifactsSpace.id}:${plan.key}`;
			return cache.contents.get(cacheKey) !== plan.markdown;
		});
		if (pendingPlans.length === 0) {
			return;
		}

		let cancelled = false;
		const persist = async () => {
			let existingByTitle = new Map<string, { id: string }>();
			try {
				const documents = await fetchDocuments(chatTarget, artifactsSpace.id);
				existingByTitle = new Map(
					documents.map((document) => [document.title, { id: document.id }])
				);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Could not read the Artifacts Space.";
				if (cancelled) {
					return;
				}
				setPlanSaveErrors((previous) => {
					const next = { ...previous };
					for (const plan of pendingPlans) {
						next[plan.key] = message;
					}
					return next;
				});
				return;
			}

			for (const plan of pendingPlans) {
				if (cancelled) {
					return;
				}
				const cacheKey = `${artifactsSpace.id}:${plan.key}`;
				if (cache.contents.get(cacheKey) === plan.markdown) {
					continue;
				}
				try {
					let documentId = cache.documents.get(cacheKey)?.documentId;
					if (!documentId) {
						documentId = existingByTitle.get(planDocumentTitle(plan))?.id;
					}
					if (documentId) {
						const current = await fetchDocument(
							chatTarget,
							artifactsSpace.id,
							documentId
						);
						if (current.source !== plan.markdown) {
							await updateDocument(
								chatTarget,
								artifactsSpace.id,
								documentId,
								planDocumentTitle(plan),
								plan.markdown
							);
						}
					} else {
						documentId = await ingestDocument(
							chatTarget,
							artifactsSpace.id,
							planDocumentTitle(plan),
							plan.markdown
						);
					}
					if (cancelled) {
						return;
					}
					const saved = {
						documentId,
						spaceId: artifactsSpace.id,
					};
					cache.documents.set(cacheKey, saved);
					cache.contents.set(cacheKey, plan.markdown);
					setSavedPlanDocuments((previous) => ({
						...previous,
						[plan.key]: saved,
					}));
					setPlanSaveErrors((previous) => {
						if (!(plan.key in previous)) {
							return previous;
						}
						const next = { ...previous };
						delete next[plan.key];
						return next;
					});
				} catch (error) {
					if (cancelled) {
						return;
					}
					const message =
						error instanceof Error
							? error.message
							: "Could not save this plan.";
					setPlanSaveErrors((previous) => ({
						...previous,
						[plan.key]: message,
					}));
				}
			}
		};

		planSyncQueueRef.current = planSyncQueueRef.current
			.catch(() => undefined)
			.then(persist);
		return () => {
			cancelled = true;
		};
	}, [
		artifactsSpace,
		chatTarget,
		planSnapshots,
		planTargetKey,
		spacesError,
		spacesLoading,
	]);
	return {
		councilInputBar,
		hasThread,
		hasMessages,
		subagentSummaries,
		planSnapshots,
		savedPlanDocuments,
		planSaveErrors,
	} as const;
}
