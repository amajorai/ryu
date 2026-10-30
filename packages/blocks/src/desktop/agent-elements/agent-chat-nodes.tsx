import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { agentAvailabilityLabel } from "../agent-availability.tsx";
import type { useAgentChatDraft } from "./agent-chat-draft.ts";
import {
	availabilityInfoDescription,
	buildQuestionBar,
	CHAT_LAYOUT_TRANSITION,
	HistoryPlaceholder,
} from "./agent-chat-helpers.tsx";
import type { useAgentChatPrompts } from "./agent-chat-prompts.tsx";
import type { AgentChatBaseScope } from "./agent-chat-scope.ts";
import { LiveMessageList } from "./live-message-list.tsx";
import { ComposerQuotePreview } from "./quote.tsx";

export type GetAgentChatNodesInput = AgentChatBaseScope &
	ReturnType<typeof useAgentChatDraft> &
	ReturnType<typeof useAgentChatPrompts>;

/** The input bar, transcript, leading content and chat stage elements. */
export function getAgentChatNodes({
	ResolvedInputBar,
	isCenteredEmptyState,
	visibleComposerPrompt,
	contextMeter,
	resolvedDraftControls,
	promptsPaused,
	availability,
	handleDraftChange,
	isEmpty,
	followUpItems,
	suggestionConfig,
	visiblePendingQuestion,
	questionProgress,
	setQuestionProgress,
	setLocallyAnsweredQuestions,
	showInputSuggestions,
	draft,
	attachments,
	classNames,
	density,
	quote,
	onClearQuote,
	composerHeader,
	composerMenuGroups,
	onOpenContext,
	composerDisabled,
	infoBar,
	voiceMode,
	onComposerMenuSelect,
	onComposerResize,
	onSend,
	onStop,
	error,
	composerPrediction,
	questionTool,
	status,
	showPlaceholder,
	listMessages,
	liveMessages,
	withTranscriptExtras,
	historyError,
	agentMessageContext,
	answerNow,
	assistantAvatar,
	assistantName,
	assistantPlanningAvatars,
	assistantTitle,
	contextSize,
	conversationKey,
	currentUser,
	enableImagePreview,
	goalCompletion,
	hasOlderMessages,
	historyNotice,
	historyNotices,
	initialScrollBehavior,
	loadingOlderMessages,
	mentionItems,
	messageActionStates,
	messageActions,
	messageReadReceipts,
	onAgentUiSubmit,
	onAnnotateImage,
	onBranch,
	onContributedMessageAction,
	onContributedSelectionAction,
	onEditMessage,
	onLoadOlderMessages,
	onMessageVisible,
	onOpenFile,
	onOpenLink,
	onOpenMention,
	onQuote,
	onRegenerateMessage,
	onReply,
	onRetryError,
	onRetryGeneration,
	onReviewFileEdits,
	onRewindMessage,
	onSelectVersion,
	onSpeak,
	onUndoFileEdits,
	onWorkflowResume,
	previewResolvers,
	searchActiveMessageId,
	selectionActions,
	showCopyToolbar,
	slots,
	statsModelName,
	statsPluginEnabled,
	statsUsage,
	toolRenderers,
	versions,
	reduceMotion,
	emptySuggestionsNode,
	suggestedTaskNode,
	followUpsNode,
	emptyStateFooterNode,
	emptyStateHeader,
	emptySuggestionsPosition,
	emptyStateFooter,
	composerFooter,
	rootRef,
	className,
	style,
	conversationHeader,
}: GetAgentChatNodesInput) {
	const inputBarNode = (
		<ResolvedInputBar
			attachedFiles={attachments?.files}
			attachedImages={attachments?.images}
			className={cn(classNames?.inputBar, isCenteredEmptyState && "px-0 pb-0")}
			compact={density === "compact"}
			composerHeader={
				<>
					{quote ? (
						<ComposerQuotePreview onDismiss={onClearQuote} text={quote} />
					) : null}
					{composerHeader}
				</>
			}
			composerMenuGroups={composerMenuGroups}
			composerPrompt={visibleComposerPrompt ?? undefined}
			contextMeter={contextMeter}
			contextMeterOnOpen={onOpenContext}
			disabled={composerDisabled}
			draftControls={resolvedDraftControls}
			infoBar={
				infoBar ??
				(promptsPaused
					? {
							description: availabilityInfoDescription(availability),
							title:
								availability === "away"
									? "Away mode"
									: availability === "gaming"
										? "Gaming mode"
										: availability === "streaming"
											? "Streaming mode"
											: agentAvailabilityLabel(availability),
						}
					: undefined)
			}
			isDragOver={attachments?.isDragOver}
			liveCall={voiceMode?.active ? voiceMode.liveCall : undefined}
			onAnnotateImage={attachments?.onAnnotateImage}
			onAttach={attachments?.onAttach}
			onChange={handleDraftChange}
			onComposerMenuSelect={onComposerMenuSelect}
			onHeightChange={onComposerResize}
			onPaste={attachments?.onPaste}
			onRemoveFile={attachments?.onRemoveFile}
			onRemoveImage={attachments?.onRemoveImage}
			onSend={onSend}
			onSketch={attachments?.onSketch}
			onStop={onStop}
			placeholder={isEmpty ? "Send a message" : "Ask a follow up"}
			placeholderSuggestion={
				(followUpItems[0] ?? suggestionConfig.items[0])?.label
			}
			prediction={
				isCenteredEmptyState || error ? undefined : composerPrediction
			}
			questionBar={
				visiblePendingQuestion
					? buildQuestionBar({
							pending: visiblePendingQuestion,
							progress: questionProgress,
							questionTool,
							setProgress: setQuestionProgress,
							onComplete: (id) =>
								setLocallyAnsweredQuestions((previous) => {
									const next = new Set(previous);
									next.add(id);
									return next;
								}),
						})
					: undefined
			}
			status={status}
			suggestions={
				showInputSuggestions
					? followUpItems.length > 0
						? followUpItems
						: suggestionConfig.items
					: []
			}
			value={draft}
		/>
	);

	let transcriptNode: ReactNode;
	if (showPlaceholder) {
		transcriptNode = (
			<HistoryPlaceholder classNames={classNames} error={historyError} />
		);
	} else {
		transcriptNode = (
			<LiveMessageList
				agentMessageContext={agentMessageContext}
				answerNow={answerNow}
				assistantAvatar={assistantAvatar}
				assistantName={assistantName}
				assistantPlanningAvatars={assistantPlanningAvatars}
				assistantTitle={assistantTitle}
				classNames={classNames}
				contextSize={contextSize}
				conversationKey={conversationKey}
				currentUser={currentUser}
				enableImagePreview={enableImagePreview}
				goalCompletion={goalCompletion}
				hasOlderMessages={hasOlderMessages}
				// Declared and destructured since the prop was introduced, but never
				// actually handed to the transcript — so a surface that set it got
				// nothing on screen. It renders as a `Marker` after the last message
				// (see MessageListProps.historyNotice).
				historyNotice={historyNotice}
				historyNotices={historyNotices}
				initialScrollBehavior={initialScrollBehavior}
				liveMessages={liveMessages}
				loadingOlderMessages={loadingOlderMessages}
				mentionItems={mentionItems}
				messageActionStates={messageActionStates}
				messageActions={messageActions}
				messageReadReceipts={messageReadReceipts}
				messages={listMessages}
				onAgentUiSubmit={onAgentUiSubmit}
				onAnnotateImage={onAnnotateImage}
				onBranch={onBranch}
				onContributedMessageAction={onContributedMessageAction}
				onContributedSelectionAction={onContributedSelectionAction}
				onEditMessage={onEditMessage}
				onLoadOlderMessages={onLoadOlderMessages}
				onMessageVisible={onMessageVisible}
				onOpenFile={onOpenFile}
				onOpenLink={onOpenLink}
				onOpenMention={onOpenMention}
				onQuote={onQuote}
				onRegenerateMessage={onRegenerateMessage}
				onReply={onReply}
				onRetryError={onRetryError}
				onRetryGeneration={onRetryGeneration}
				onReviewFileEdits={onReviewFileEdits}
				onRewindMessage={onRewindMessage}
				onSelectVersion={onSelectVersion}
				onSpeak={onSpeak}
				onUndoFileEdits={onUndoFileEdits}
				onWorkflowResume={onWorkflowResume}
				previewResolvers={previewResolvers}
				searchActiveMessageId={searchActiveMessageId}
				selectionActions={selectionActions}
				showCopyToolbar={showCopyToolbar}
				slots={slots}
				statsModelName={statsModelName}
				statsPluginEnabled={statsPluginEnabled}
				statsUsage={statsUsage}
				status={status}
				suppressQuestionTool={Boolean(visiblePendingQuestion)}
				toolRenderers={toolRenderers}
				versions={versions}
				withTranscriptExtras={withTranscriptExtras}
			/>
		);
	}

	// Keep the centered start page and the active transcript in one stage. The
	// composer below is intentionally a sibling of the leading content in both
	// states, so Motion can interpolate its measured position instead of React
	// unmounting one composer and mounting another. The centered stage scrolls when
	// the launchpad footer outgrows a short pane; `my-auto` centers it only while it
	// fits, keeping the greeting and composer reachable in either case.
	const chatLeadingNode = isCenteredEmptyState ? (
		<motion.div
			animate={{ opacity: 1, y: 0 }}
			className="flex w-full flex-col"
			data-chat-empty-intro="true"
			exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
			initial={reduceMotion ? false : { opacity: 1, y: 0 }}
			key="empty-chat-intro"
			layout={reduceMotion ? false : "position"}
			transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
		>
			{emptyStateHeader}
			{emptySuggestionsPosition === "top" ? emptySuggestionsNode : null}
		</motion.div>
	) : (
		<motion.div
			className="flex min-h-0 flex-1 flex-col"
			data-chat-transcript="true"
			initial={false}
			key="active-chat-transcript"
			layout={reduceMotion ? false : "position"}
		>
			{transcriptNode}
			{suggestedTaskNode}
			{followUpsNode}
			{emptyStateFooterNode}
		</motion.div>
	);

	const chatStage = (
		<motion.div
			className={cn(
				"flex min-h-0 flex-1",
				isCenteredEmptyState
					? "scroll-fade items-start justify-center overflow-y-auto px-4 py-4"
					: "flex-col overflow-hidden"
			)}
			data-chat-layout={isCenteredEmptyState ? "empty" : "active"}
			layout={reduceMotion ? false : "position"}
			transition={CHAT_LAYOUT_TRANSITION}
		>
			<motion.div
				className={cn(
					"w-full",
					isCenteredEmptyState
						? "my-auto flex max-w-[880px] flex-col"
						: "flex min-h-0 flex-1 flex-col"
				)}
				layout={reduceMotion ? false : "position"}
				transition={CHAT_LAYOUT_TRANSITION}
			>
				<AnimatePresence initial={false} mode="popLayout">
					{chatLeadingNode}
				</AnimatePresence>
				<motion.div
					className="w-full"
					data-chat-composer-transition="true"
					layout={!reduceMotion}
					transition={reduceMotion ? { duration: 0 } : CHAT_LAYOUT_TRANSITION}
				>
					{inputBarNode}
				</motion.div>
				{isCenteredEmptyState ? (
					<>
						{emptySuggestionsPosition === "bottom"
							? emptySuggestionsNode
							: null}
						{emptyStateFooter}
					</>
				) : composerFooter ? (
					<div className="shrink-0 px-3 pb-2">{composerFooter}</div>
				) : null}
			</motion.div>
		</motion.div>
	);

	const chatNode = (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col",
				classNames?.root,
				className
			)}
			data-agent-availability={availability}
			data-chat-motion={reduceMotion ? "off" : "on"}
			data-chat-state={isCenteredEmptyState ? "empty" : "active"}
			ref={rootRef}
			style={style}
		>
			{conversationHeader ? (
				<div className="shrink-0">{conversationHeader}</div>
			) : null}
			{chatStage}
		</div>
	);
	return { chatNode } as const;
}
