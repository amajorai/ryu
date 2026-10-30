import { AgentUiStateHostContext } from "@ryu/blocks/desktop/agent-elements/agent-ui/state-host-context.tsx";
import type { GoalCompletion } from "@ryu/blocks/desktop/agent-elements/goal-message.ts";
import { ModelContextAttachments } from "@ryu/blocks/desktop/agent-elements/model-context-attachments.tsx";
import { WidgetHostContext } from "@ryu/blocks/desktop/agent-elements/widget-host-context.tsx";
import { useMemo } from "react";
import { AgentChat } from "@/components/agent-elements/agent-chat.tsx";
import { EmptyStateHeader } from "@/components/agent-elements/empty-state-header.tsx";
import { AppLaunchpad } from "@/src/components/chat/AppLaunchpad.tsx";
import { BotChatHeader } from "@/src/components/chat/BotChatHeader.tsx";
import { ThreadHierarchyBar } from "@/src/components/chat/ThreadHierarchyBar.tsx";
import { EMPTY_TOOL_RENDERERS } from "./ChatPage.helpers.ts";
import type { ChatPageScope } from "./ChatPage.types.ts";

/**
 * Transcript props that are objects, kept stable across streamed chunks. The
 * transcript memoises each settled turn on its props, so an inline object
 * here would re-render every turn on every token.
 */
export function useChatTranscriptStableProps({
	botProduct,
	goalCompletionMessageId,
	goalState,
	myUserId,
	oidcUser,
}: ChatPageScope) {
	const avatar = oidcUser?.picture;
	const name = oidcUser?.name || oidcUser?.email;
	const currentUser = useMemo(
		() => ({ avatar, id: myUserId ?? undefined, name }),
		[avatar, myUserId, name]
	);
	const achieved = !botProduct && goalState?.status === "achieved";
	const achievedAt = achieved ? goalState.achieved_at : undefined;
	const startedAt = achieved ? goalState.started_at : undefined;
	const goalCompletion = useMemo(
		() =>
			achieved
				? ({
						achievedAt,
						messageId: goalCompletionMessageId ?? undefined,
						startedAt,
					} satisfies GoalCompletion)
				: undefined,
		[achieved, achievedAt, goalCompletionMessageId, startedAt]
	);
	return { currentUser, goalCompletion } as const;
}

type ChatTranscriptStableProps = ReturnType<
	typeof useChatTranscriptStableProps
>;

/** The transcript column: the chat surface, its composer, and find in chat. */
export function renderChatTranscript(
	{
		widgetHostValue,
		agentUiStateHost,
		agentMessageContext,
		answerNowControl,
		assistantIdentity,
		assistantPlanningAvatars,
		attachedImages,
		handleAttach,
		drawesomeCompanion,
		handleOpenDrawesome,
		handleOpenImageEditor,
		handleRemoveImage,
		handlePaste,
		isDragOver,
		botProduct,
		composerBlocked,
		modelSelectionLoading,
		hasAppContext,
		mentionableResources,
		chatTarget,
		convId,
		draftConvId,
		composerPrediction,
		contextSize,
		hierarchyConversation,
		botHeaderAgent,
		agentNameForId,
		conversations,
		openHierarchyConversation,
		draftControls,
		clipsDraftInsertion,
		emptyStateLogo,
		composerRenderBody,
		composerTriggerSections,
		ghostChatActive,
		error,
		followUps,
		setFollowUps,
		handleComposerSubmit,
		hasOlderMessages,
		historyFailed,
		historyErrorCopy,
		retryHistoryLoad,
		historyLoading,
		latestAcpTranscriptNotice,
		conversationModelNotices,
		chatId,
		loadingOlderMessages,
		resolvedMentionItems,
		messageActionStates,
		contributedMessageActions,
		messageReadReceiptStates,
		renderedMessages,
		liveTranscriptMessages,
		handleAgentUiSubmit,
		activeConversationId,
		handleBranch,
		clearReply,
		handleContributedMessageAction,
		handleContributedSelectionAction,
		handleDraftChange,
		handleDraftInsertionConsumed,
		handleEditMessage,
		loadOlderMessages,
		handleMessageVisible,
		handleOpenContext,
		handleOpenFileLink,
		handleOpenWebsiteLink,
		handleOpenMention,
		handleQuote,
		handleRegenerateMessage,
		handleReply,
		handleRetryError,
		handleRetryGeneration,
		handleReviewFileEdits,
		handleRewindMessage,
		handleSelectVersion,
		handleSpeak,
		handleStop,
		handleUndoFileEdits,
		handleWorkflowResume,
		linkPreviewResolvers,
		questionTool,
		quote,
		chatSearch,
		activeChatSearchMatch,
		composerSeed,
		contributedSelectionActions,
		councilInputBar,
		cacheModelHint,
		statsPluginEnabled,
		agentId,
		statsUsage,
		effectiveStatus,
		taskSuggestionActions,
		versions,
		voiceModeSlot,
		teamId,
	}: ChatPageScope,
	{ currentUser, goalCompletion }: ChatTranscriptStableProps
) {
	// A one-to-one chat shows the reply as plain prose; only a multi-agent
	// (team) thread names who answered, with a small avatar beside the name.
	const multiAgent = Boolean(teamId);
	return (
		<WidgetHostContext.Provider value={widgetHostValue}>
			<AgentUiStateHostContext.Provider value={agentUiStateHost}>
				<AgentChat
					agentMessageContext={agentMessageContext}
					answerNow={answerNowControl}
					assistantAvatar={multiAgent ? assistantIdentity.avatar : undefined}
					assistantName={multiAgent ? assistantIdentity.name : undefined}
					assistantPlanningAvatars={assistantPlanningAvatars}
					assistantTitle={multiAgent ? assistantIdentity.title : undefined}
					attachments={{
						images: attachedImages,
						onAttach: handleAttach,
						onSketch: drawesomeCompanion ? handleOpenDrawesome : undefined,
						onAnnotateImage: handleOpenImageEditor,
						onRemoveImage: handleRemoveImage,
						onPaste: handlePaste,
						isDragOver,
					}}
					// Pad the message list down by the titlebar height so the
					// conversation rests below the frosted bar yet scrolls under it.
					classNames={{
						messageList: botProduct
							? ""
							: "pt-[var(--ryu-titlebar-inset,3rem)]",
					}}
					composerDisabled={composerBlocked || modelSelectionLoading}
					composerHeader={
						hasAppContext || mentionableResources.error ? (
							<>
								<ModelContextAttachments
									scope={`${chatTarget.url}:${convId ?? draftConvId.current}`}
								/>
								{mentionableResources.error ? (
									<p
										className="px-3 text-sm text-status-destructive"
										role="status"
									>
										{mentionableResources.error}
									</p>
								) : null}
							</>
						) : undefined
					}
					composerPrediction={composerPrediction ?? undefined}
					contextSize={contextSize}
					conversationHeader={
						botProduct || hierarchyConversation ? (
							<>
								{botProduct ? <BotChatHeader agent={botHeaderAgent} /> : null}
								{hierarchyConversation ? (
									<ThreadHierarchyBar
										agentName={agentNameForId}
										conversation={hierarchyConversation}
										conversations={conversations}
										onOpenConversation={openHierarchyConversation}
										target={chatTarget}
									/>
								) : null}
							</>
						) : undefined
					}
					// Opening this thread jumps the transcript to the newest
					// message; the id is what makes that fire once per
					// conversation rather than on every history rewrite.
					conversationKey={convId ?? undefined}
					currentUser={currentUser}
					draftControls={draftControls}
					draftInsertion={clipsDraftInsertion ?? undefined}
					// Launchpad: every openable app as a grid of icon tiles under
					// the composer, on the start page only. Renders nothing when no
					// enabled app contributes a UI surface.
					emptyStateFooter={botProduct ? null : <AppLaunchpad />}
					emptyStateHeader={
						<EmptyStateHeader
							interactiveLogo={!botProduct}
							logo={emptyStateLogo}
							// The full Agent · Model · Thinking dropdown from the shared
							// composer factory — the logo opens the identical menu the
							// composer's settings trigger does, not just an agent list.
							renderBody={composerRenderBody}
							// The narrowed list: this logo IS a settings trigger, so it
							// summarises exactly what the composer's own trigger does.
							sections={composerTriggerSections}
							showProjectPicker={!botProduct}
							// Temporary chat: the empty-state greeting whispers
							// "secretly" so it's obvious this thread won't be saved.
							title={
								ghostChatActive ? "What are we secretly doing?" : undefined
							}
						/>
					}
					emptyStatePosition="center"
					error={error ?? undefined}
					followUps={{
						items: followUps.map((text, i) => ({
							id: `followup-${i}`,
							label: text,
							value: text,
						})),
						// One click runs the suggested next prompt straight away.
						onSelect: (item) => {
							setFollowUps([]);
							handleComposerSubmit({
								role: "user",
								content: item.value ?? item.label,
							});
						},
					}}
					goalCompletion={goalCompletion}
					hasOlderMessages={hasOlderMessages}
					// A restored tab must say "loading this conversation", never
					// paint the new-chat greeting — that is what reads as "all my
					// chats are gone" at boot. Both flags are false for a genuinely
					// new chat (no conversation id), so the greeting is untouched
					// there.
					historyError={
						historyFailed
							? {
									...historyErrorCopy,
									onRetry: retryHistoryLoad,
								}
							: undefined
					}
					historyLoading={historyLoading}
					historyNotice={latestAcpTranscriptNotice ?? undefined}
					historyNotices={conversationModelNotices}
					key={chatId}
					// Streamed text reaches the transcript alone; this page re-renders
					// only when the conversation changes shape or a turn ends.
					liveMessages={liveTranscriptMessages}
					loadingOlderMessages={loadingOlderMessages}
					mentionItems={resolvedMentionItems}
					messageActionStates={messageActionStates}
					messageActions={contributedMessageActions}
					messageReadReceipts={messageReadReceiptStates}
					messages={renderedMessages}
					onAgentUiSubmit={handleAgentUiSubmit}
					onBranch={activeConversationId ? handleBranch : undefined}
					onClearQuote={clearReply}
					onContributedMessageAction={
						activeConversationId ? handleContributedMessageAction : undefined
					}
					onContributedSelectionAction={handleContributedSelectionAction}
					onDraftChange={handleDraftChange}
					onDraftInsertionConsumed={handleDraftInsertionConsumed}
					onEditMessage={activeConversationId ? handleEditMessage : undefined}
					onLoadOlderMessages={loadOlderMessages}
					onMessageVisible={handleMessageVisible}
					onOpenContext={handleOpenContext}
					onOpenFile={handleOpenFileLink}
					onOpenLink={handleOpenWebsiteLink}
					onOpenMention={handleOpenMention}
					onQuote={handleQuote}
					onRegenerateMessage={
						activeConversationId ? handleRegenerateMessage : undefined
					}
					onReply={handleReply}
					onRetryError={handleRetryError}
					// Unconditional: a generation part is client-only, so retrying
					// one needs no persisted conversation (unlike regenerate above).
					onRetryGeneration={handleRetryGeneration}
					onReviewFileEdits={handleReviewFileEdits}
					onRewindMessage={
						activeConversationId ? handleRewindMessage : undefined
					}
					onSelectVersion={
						activeConversationId ? handleSelectVersion : undefined
					}
					onSend={handleComposerSubmit}
					onSpeak={handleSpeak}
					onStop={handleStop}
					onUndoFileEdits={handleUndoFileEdits}
					onWorkflowResume={handleWorkflowResume}
					previewResolvers={linkPreviewResolvers}
					questionTool={questionTool}
					quote={quote}
					searchActiveMessageId={
						chatSearch.open && chatSearch.mode === "chat"
							? activeChatSearchMatch?.messageId
							: undefined
					}
					seedDraft={composerSeed}
					selectionActions={contributedSelectionActions}
					showCopyToolbar
					slots={{ InputBar: councilInputBar }}
					statsModelName={cacheModelHint ?? undefined}
					statsPluginEnabled={statsPluginEnabled}
					statsProviderHint={agentId ?? undefined}
					statsUsage={statsUsage}
					status={effectiveStatus}
					taskSuggestions={botProduct ? undefined : taskSuggestionActions}
					toolRenderers={EMPTY_TOOL_RENDERERS}
					versions={versions}
					voiceMode={voiceModeSlot}
				/>
			</AgentUiStateHostContext.Provider>
		</WidgetHostContext.Provider>
	);
}
