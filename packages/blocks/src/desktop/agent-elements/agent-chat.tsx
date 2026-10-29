"use client";

import { AvatarConversationProvider } from "@ryu/ui/components/avatar-conversation.tsx";
import { Button } from "@ryu/ui/components/button";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { useMediaQuery } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	agentAvailabilityLabel,
	useAgentAvailability,
} from "../agent-availability.tsx";
import {
	ChatDisplayPrefsProvider,
	useChatDisplayPrefs,
} from "./chat-display-prefs.tsx";
import { deriveContextUsage } from "./context-usage.tsx";
import {
	ConversationActivityProvider,
	describeConversationActivity,
} from "./conversation-activity.ts";
import { type SuggestionItem, Suggestions } from "./input/suggestions.tsx";
import { InputBar } from "./input-bar.tsx";
import { MessageList } from "./message-list.tsx";
import {
	answeredQuestionIds,
	isAsyncQuestionPart,
	isQuestionPartOpen,
} from "./question/async-question.ts";
import type {
	QuestionAnswer,
	QuestionConfig,
} from "./question/question-prompt.tsx";
import { ComposerQuotePreview } from "./quote.tsx";
import {
	latestSuggestedTask,
	type SuggestedTask,
} from "./tools/suggested-task.ts";
import { SuggestedTaskCard } from "./tools/suggested-task-card.tsx";
import type { AgentChatProps } from "./types.ts";
import { useDeferredComposerPrompt } from "./use-deferred-question.ts";
import type { RenderedMessage } from "./utils/native-sdk-observation.ts";

export function appendDraftInsertion(draft: string, insertion: string): string {
	const text = insertion.trim();
	if (!text) {
		return draft;
	}
	const existingDraft = draft.trimEnd();
	return existingDraft ? `${existingDraft}\n\n${text}` : text;
}

export function mergeDraftSeedWithInsertions(
	seed: string,
	insertions: readonly string[]
): string {
	return insertions.reduce(appendDraftInsertion, seed);
}

/** Suggested-task cards dismissed this session, by tool call id. Module scope
 *  so a chat that remounts (tab switch, split) keeps them dismissed. */
const sessionDismissedTasks = new Set<string>();

const CHAT_LAYOUT_TRANSITION = {
	damping: 34,
	mass: 0.75,
	stiffness: 420,
	type: "spring" as const,
};

export function AgentChat({
	messages,
	answerNow,
	onSend,
	status,
	onStop,
	error,
	classNames,
	slots,
	toolRenderers,
	attachments,
	showCopyToolbar,
	conversationHeader,
	onBranch,
	onAgentUiSubmit,
	onEditMessage,
	onRewindMessage,
	onRegenerateMessage,
	onRetryError,
	onRetryGeneration,
	messageActions,
	messageActionStates,
	messageReadReceipts,
	onContributedMessageAction,
	selectionActions,
	onContributedSelectionAction,
	onSelectVersion,
	versions,
	onSpeak,
	onQuote,
	onReply,
	onOpenFile,
	onReviewFileEdits,
	onUndoFileEdits,
	onOpenLink,
	onOpenMention,
	onAnnotateImage,
	mentionItems,
	onWorkflowResume,
	previewResolvers,
	quote,
	onClearQuote,
	initialScrollBehavior,
	enableImagePreview,
	assistantAvatar,
	assistantName,
	assistantTitle,
	assistantPlanningAvatars,
	agentMessageContext,
	composerPrompt,
	composerMenuGroups,
	density,
	composerDisabled,
	composerFooter,
	composerHeader,
	composerPrediction,
	voiceMode,
	infoBar,
	onComposerMenuSelect,
	onComposerResize,
	currentUser,
	seedDraft,
	onSeedDraftConsumed,
	draftInsertion,
	onDraftInsertionConsumed,
	onDraftChange,
	suggestions,
	followUps,
	taskSuggestions,
	emptyStatePosition = "default",
	emptySuggestionsPlacement = "input",
	emptySuggestionsPosition = "top",
	emptyStateHeader,
	emptyStateFooter,
	historyLoading,
	historyError,
	historyNotices,
	hasOlderMessages,
	loadingOlderMessages,
	onLoadOlderMessages,
	onMessageVisible,
	questionTool,
	historyNotice,
	className,
	style,
	contextSize,
	conversationKey,
	goalCompletion,
	searchActiveMessageId,
	statsPluginEnabled,
	statsUsage,
	statsModelName,
	statsProviderHint,
	onOpenContext,
	draftControls,
}: AgentChatProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const { animationsEnabled } = useChatDisplayPrefs();
	const availability = useAgentAvailability();
	const promptsPaused = availability !== "online";
	const prefersReducedMotion = useMediaQuery(
		"(prefers-reduced-motion: reduce)"
	);
	const reduceMotion = !animationsEnabled || prefersReducedMotion;
	const [draft, setDraft] = useState("");
	const draftTouchedRef = useRef(false);
	const consumedDraftInsertionIdRef = useRef<number | null>(null);
	const pendingDraftInsertionsRef = useRef<string[]>([]);
	const setDraftFromUser = useCallback((nextDraft: string) => {
		draftTouchedRef.current = true;
		setDraft(nextDraft);
	}, []);
	const resolvedDraftControls = draftControls
		? { ...draftControls, onInsert: setDraftFromUser }
		: undefined;

	// Apply a composer seed (e.g. from a deep link) once per distinct value, so a
	// pre-filled prompt lands in the textarea without clobbering later edits.
	const seededValueRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (
			seedDraft &&
			seedDraft !== seededValueRef.current &&
			!draftTouchedRef.current &&
			(draft.length === 0 || pendingDraftInsertionsRef.current.length > 0)
		) {
			seededValueRef.current = seedDraft;
			setDraft(
				mergeDraftSeedWithInsertions(
					seedDraft,
					pendingDraftInsertionsRef.current
				)
			);
			pendingDraftInsertionsRef.current = [];
			onSeedDraftConsumed?.();
		}
	}, [draft, onSeedDraftConsumed, seedDraft]);

	useEffect(() => {
		if (
			!draftInsertion ||
			draftInsertion.id === consumedDraftInsertionIdRef.current
		) {
			return;
		}
		consumedDraftInsertionIdRef.current = draftInsertion.id;
		const text = draftInsertion.text.trim();
		if (text) {
			if (!seededValueRef.current) {
				pendingDraftInsertionsRef.current.push(text);
			}
			setDraft((current) => appendDraftInsertion(current, text));
		}
		onDraftInsertionConsumed?.(draftInsertion.id);
	}, [draftInsertion, onDraftInsertionConsumed]);

	// Observe the composer text for surfaces that persist it (the desktop keeps
	// unsent text as a draft). A ref for the callback so a consumer passing an
	// inline arrow does not re-fire this on every render — the DRAFT changing is
	// the event, not the identity of the listener.
	const draftListener = useRef(onDraftChange);
	draftListener.current = onDraftChange;
	useEffect(() => {
		draftListener.current?.(draft);
	}, [draft]);

	const ResolvedInputBar = slots?.InputBar ?? InputBar;

	// Context-window meter for the composer: the fullness of THIS conversation,
	// derived from the latest turn's usage stats. The denominator prefers an
	// ACP-reported window, else the model's `contextSize` (launch config /
	// models.dev). Null (no meter) until a turn reports usage — it is live-only.
	// The model/provider hints key the prompt-cache TTL when a part omits them.
	const contextMeter = useMemo(
		() =>
			deriveContextUsage(messages, contextSize, {
				model: statsModelName,
				provider: statsProviderHint,
			}) ?? undefined,
		[messages, contextSize, statsModelName, statsProviderHint]
	);

	// A failed request is shown as a synthetic trailing assistant message. Built
	// in a memo rather than inline in the JSX because a fresh array literal there
	// hands MessageList a new `messages` identity on EVERY render for as long as
	// an error is on screen — which invalidates normalizeMessages /
	// groupMessagesIntoTurns / the TOC continuously, and re-arms the pinned-message
	// measuring effect every pass (the escalation path to React error #185).
	const voiceMessages = voiceMode?.active ? voiceMode.messages : undefined;
	const transcriptMessages = useMemo(
		() =>
			voiceMessages && voiceMessages.length > 0
				? [...messages, ...voiceMessages]
				: messages,
		[messages, voiceMessages]
	);
	const listMessages = useMemo(
		() =>
			error
				? [
						...transcriptMessages,
						{
							id: "agent-chat-error",
							role: "assistant",
							parts: [
								{
									type: "error",
									title: "Request failed",
									message: error.message,
								},
							],
						} satisfies RenderedMessage,
					]
				: transcriptMessages,
		[error, transcriptMessages]
	);

	// "Nothing in this thread" and "this thread has not arrived yet" are different
	// facts, and only the first one may show the new-chat greeting. A restored tab
	// paints before its history resolves, so deriving emptiness from the message
	// count ALONE is what made every reopened conversation look like a brand-new
	// chat at boot — the alarming "all my chats are gone" screen. `historyLoading`
	// and `historyError` are only ever set for a thread that HAS a conversation
	// id, so a real new chat still gets its greeting.
	const isPlaceholder = Boolean(historyLoading || historyError);
	const isStreaming = status === "streaming" || status === "submitted";
	// A submitted turn is already a real chat, even if the transport has not
	// appended the optimistic user message yet. Leaving the empty layout mounted
	// for that gap made the composer teleport only after the first stream frame.
	const isEmpty =
		!(error || isPlaceholder) &&
		transcriptMessages.length === 0 &&
		!isStreaming;
	const isCenteredEmptyState = isEmpty && emptyStatePosition === "center";
	// The placeholder replaces the transcript only while there is nothing to show;
	// a re-fetch over an already-rendered thread must not blank it.
	const showPlaceholder =
		isPlaceholder && !error && transcriptMessages.length === 0;

	// Cards answered in this session hide at once; the transcript marker (async)
	// or the tool output (blocking) keeps them closed after a reload.
	const [locallyAnsweredQuestions, setLocallyAnsweredQuestions] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const answeredQuestions = useMemo(() => {
		const ids = answeredQuestionIds(messages);
		for (const id of locallyAnsweredQuestions) {
			ids.add(id);
		}
		return ids;
	}, [messages, locallyAnsweredQuestions]);
	const pendingQuestion = useMemo(
		() => findPendingQuestion(messages, questionTool, answeredQuestions),
		[messages, questionTool, answeredQuestions]
	);
	// Answers collected so far for a multi-question card. The card is submitted
	// to the host once, with every answer, after its last question.
	const [questionProgress, setQuestionProgress] = useState<{
		answers: QuestionAnswer[];
		id: string;
	} | null>(null);
	const {
		markComposerActivity: markQuestionActivity,
		markComposerIdle: markQuestionIdle,
		visiblePrompt: visiblePendingQuestion,
	} = useDeferredComposerPrompt(pendingQuestion, undefined, promptsPaused);
	const {
		markComposerActivity: markPromptActivity,
		markComposerIdle: markPromptIdle,
		visiblePrompt: visibleComposerPrompt,
	} = useDeferredComposerPrompt(composerPrompt, undefined, promptsPaused);
	const handleDraftChange = useCallback(
		(nextDraft: string) => {
			setDraftFromUser(nextDraft);
			if (nextDraft) {
				markQuestionActivity();
				markPromptActivity();
			} else {
				markQuestionIdle();
				markPromptIdle();
			}
		},
		[
			markPromptActivity,
			markPromptIdle,
			markQuestionActivity,
			markQuestionIdle,
			setDraftFromUser,
		]
	);
	const suggestionConfig = resolveSuggestions(suggestions);
	const showInputSuggestions =
		emptySuggestionsPlacement === "input" ||
		emptySuggestionsPlacement === "both";
	const showEmptySuggestions =
		isCenteredEmptyState &&
		(emptySuggestionsPlacement === "empty" ||
			emptySuggestionsPlacement === "both") &&
		suggestionConfig.items.length > 0;

	const handleEmptySuggestionSelect = (item: SuggestionItem) => {
		setDraftFromUser(item.value ?? item.label);
	};

	const emptySuggestionsNode = showEmptySuggestions ? (
		<Suggestions
			buttonSize="empty"
			containerClassName={cn(
				"w-full justify-center",
				emptySuggestionsPosition === "top" ? "mb-3" : "mt-3",
				suggestionConfig.className
			)}
			disabled={isStreaming}
			itemClassName={suggestionConfig.itemClassName}
			items={suggestionConfig.items}
			onSelect={handleEmptySuggestionSelect}
		/>
	) : null;
	// Compact surfaces can keep their empty-state affordances above the composer
	// without opting into the large centered start page. The full chat launchpad
	// still owns the centered branch below; this slot is intentionally only used
	// when the host chooses the ordinary/default empty layout.
	const emptyStateFooterNode =
		isEmpty && !isCenteredEmptyState ? emptyStateFooter : null;

	// ChatGPT-style follow-up chips: shown between the transcript and the
	// composer once a turn settles (never while streaming, never in the empty
	// state). Selecting one runs it immediately — this is the "one click to do
	// the next task" affordance, distinct from empty-state chips that only seed
	// the draft.
	const followUpItems = followUps?.items ?? [];
	const showFollowUps =
		!(isCenteredEmptyState || error) &&
		followUpItems.length > 0 &&
		status !== "streaming" &&
		status !== "submitted";
	const followUpsNode =
		showFollowUps && followUps ? (
			<div className="shrink-0 px-3 pb-1">
				<Suggestions
					buttonSize="follow-up"
					items={followUpItems}
					onSelect={followUps.onSelect}
				/>
			</div>
		) : null;

	// Suggested next task (`tasks.suggest`): at most one card, for the newest
	// finished turn only, under the same gates as the follow-up chips. Dismissed
	// ids are remembered for the session so switching tabs does not bring a
	// dismissed card back.
	const [dismissedTasks, setDismissedTasks] = useState<ReadonlySet<string>>(
		() => new Set(sessionDismissedTasks)
	);
	const dismissTask = useCallback((task: SuggestedTask) => {
		sessionDismissedTasks.add(task.id);
		setDismissedTasks((current) => new Set(current).add(task.id));
	}, []);
	const taskSuggestionsEnabled = taskSuggestions !== undefined;
	const suggestedTask = useMemo(
		() =>
			taskSuggestionsEnabled
				? latestSuggestedTask(messages, dismissedTasks)
				: null,
		[taskSuggestionsEnabled, messages, dismissedTasks]
	);
	const showSuggestedTask =
		suggestedTask !== null &&
		!(isCenteredEmptyState || error) &&
		status !== "streaming" &&
		status !== "submitted";
	const suggestedTaskNode =
		showSuggestedTask && taskSuggestions && suggestedTask ? (
			<div className="flex shrink-0 justify-end px-3 pb-2">
				<SuggestedTaskCard
					canStartInWorktree={taskSuggestions.canStartInWorktree}
					onDismiss={dismissTask}
					onSaveDraft={
						taskSuggestions.onSaveDraft
							? async (task) => {
									await taskSuggestions.onSaveDraft?.(task);
									dismissTask(task);
								}
							: undefined
					}
					onStart={(task, mode) => {
						dismissTask(task);
						taskSuggestions.onStart(task, mode);
					}}
					task={suggestedTask}
				/>
			</div>
		) : null;

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
			<MessageList
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
	// Stable identity: the provider memoises its merged prefs on `value`, so an
	// inline `{ density }` re-rendered every transcript consumer on every chunk.
	const densityPrefs = useMemo(
		() => (density ? { density } : undefined),
		[density]
	);
	const resolvedActivity = describeConversationActivity({
		status,
		error,
		pendingQuestion: Boolean(visiblePendingQuestion),
		messages,
	});
	// Keyed on the primitives so header consumers re-render when the activity
	// changes, not on every streamed chunk.
	const activity = useMemo(
		() => ({ label: resolvedActivity.label, state: resolvedActivity.state }),
		[resolvedActivity.label, resolvedActivity.state]
	);
	const chatSurface = (
		<AvatarConversationProvider state={activity.state}>
			<ConversationActivityProvider value={activity}>
				{chatNode}
			</ConversationActivityProvider>
		</AvatarConversationProvider>
	);

	return densityPrefs ? (
		<ChatDisplayPrefsProvider value={densityPrefs}>
			{chatSurface}
		</ChatDisplayPrefsProvider>
	) : (
		chatSurface
	);
}

/**
 * What the transcript area shows while a restored thread's history is still in
 * flight, or when it could not be fetched at all. Deliberately transcript-shaped
 * rather than a spinner: the point is that this tab is a CONVERSATION that has
 * not arrived, not an empty one. The composer stays mounted below it (rendered by
 * the caller), so the tab never reads as dead.
 */
function HistoryPlaceholder({
	classNames,
	error,
}: {
	classNames?: AgentChatProps["classNames"];
	error?: {
		description?: string;
		onRetry?: () => void;
		title: string;
	};
}) {
	if (error) {
		return (
			<div
				className={cn(
					"flex min-h-0 flex-1 items-center justify-center px-4 py-4",
					classNames?.messageList
				)}
			>
				<div className="max-w-[420px] text-center">
					<p className="font-medium text-sm">{error.title}</p>
					{error.description ? (
						<p className="mt-1 text-muted-foreground text-sm">
							{error.description}
						</p>
					) : null}
					{error.onRetry ? (
						<Button
							className="mt-3"
							onClick={error.onRetry}
							size="sm"
							variant="outline"
						>
							Try again
						</Button>
					) : null}
				</div>
			</div>
		);
	}
	return (
		<output
			aria-busy="true"
			aria-label="Loading conversation"
			className={cn(
				"flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-4 py-6",
				classNames?.messageList
			)}
		>
			<div className="flex justify-end">
				<Skeleton className="h-9 w-[45%]" />
			</div>
			<div className="flex gap-3">
				<Skeleton className="h-7 w-7 shrink-0" radius="pill" />
				<div className="flex w-full flex-col gap-2">
					<Skeleton className="h-4 w-[85%]" radius="dense" />
					<Skeleton className="h-4 w-[70%]" radius="dense" />
					<Skeleton className="h-4 w-[45%]" radius="dense" />
				</div>
			</div>
			<div className="flex justify-end">
				<Skeleton className="h-9 w-[30%]" />
			</div>
		</output>
	);
}

function resolveSuggestions(suggestions: AgentChatProps["suggestions"]) {
	if (Array.isArray(suggestions)) {
		return {
			items: suggestions,
			className: undefined,
			itemClassName: undefined,
		};
	}
	return {
		items: suggestions?.items ?? [],
		className: suggestions?.className,
		itemClassName: suggestions?.itemClassName,
	};
}

function availabilityInfoDescription(
	availability: ReturnType<typeof useAgentAvailability>
): string {
	switch (availability) {
		case "away":
			return "Agents keep working. Their questions wait here until you’re back.";
		case "gaming":
			return "Agents keep working, questions wait, and local models stay unloaded while you play.";
		case "streaming":
			return "Agents keep working, questions wait, and connected-app suggestions stay generic while you stream.";
		default:
			return "Agents keep working. Prompts stay out of the composer until you switch back to Online.";
	}
}

interface PendingQuestion {
	allowSkip?: boolean;
	async: boolean;
	id: string;
	question: QuestionConfig;
	questions: QuestionConfig[];
	skipLabel?: string;
	submitLabel?: string;
	toolCallId?: string;
	totalQuestions: number;
}

/**
 * Composer question bar for the pending card. Multi-question cards advance one
 * question per submit (the bar id changes per step so the input bar re-opens),
 * and the host receives every answer together once the last one is in.
 */
function buildQuestionBar({
	pending,
	progress,
	questionTool,
	setProgress,
	onComplete,
}: {
	pending: PendingQuestion;
	progress: { answers: QuestionAnswer[]; id: string } | null;
	questionTool: AgentChatProps["questionTool"];
	setProgress: (next: { answers: QuestionAnswer[]; id: string } | null) => void;
	onComplete: (id: string) => void;
}) {
	const answered = progress?.id === pending.id ? progress.answers : [];
	const step = Math.min(answered.length, pending.totalQuestions - 1);
	return {
		id: `${pending.id}#${step}`,
		questions: pending.questions,
		questionIndex: step + 1,
		totalQuestions: pending.totalQuestions,
		onPreviousQuestion: () => {
			if (answered.length > 0) {
				setProgress({ answers: answered.slice(0, -1), id: pending.id });
			}
		},
		// Later questions open only after the current one is answered.
		onNextQuestion: () => undefined,
		submitLabel: pending.submitLabel,
		skipLabel: pending.skipLabel,
		allowSkip: pending.allowSkip,
		onSubmit: (answer: QuestionAnswer) => {
			questionTool?.onAnswer?.({
				toolCallId: pending.toolCallId,
				question: pending.questions[step] ?? pending.question,
				answer,
			});
			const answers = [...answered, answer];
			if (answers.length < pending.totalQuestions) {
				setProgress({ answers, id: pending.id });
				return;
			}
			setProgress(null);
			if (questionTool?.onAnswers) {
				onComplete(pending.id);
				questionTool.onAnswers({
					answers,
					async: pending.async,
					questions: pending.questions,
					toolCallId: pending.toolCallId,
				});
			}
		},
	};
}

interface QuestionToolPartObservation {
	input?: {
		allowSkip?: boolean;
		async?: unknown;
		question?: QuestionConfig;
		questions?: QuestionConfig[];
		skipLabel?: string;
		submitLabel?: string;
	};
	output?: unknown;
	toolCallId?: string;
	type?: string;
}

/**
 * The newest Question card that still wants an answer. Async cards stay open
 * anywhere in the transcript until answered, because the agent moved on without
 * them. A blocking card only counts in the newest assistant message: an older
 * one that never produced output belongs to an interrupted turn.
 */
export function findPendingQuestion(
	messages: AgentChatProps["messages"],
	questionTool: AgentChatProps["questionTool"],
	answeredIds: ReadonlySet<string>
): PendingQuestion | null {
	let newestAssistant = true;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}
		const parts = message.parts ?? [];
		for (let p = parts.length - 1; p >= 0; p -= 1) {
			// SAFETY: This is only the live Question field observation for the SDK/Core
			// part union. The tag and question existence checks below gate consumption;
			// callbacks/output retain the native SDK producer contract unchanged.
			const part = parts[p] as QuestionToolPartObservation;
			if (part?.type !== "tool-Question") {
				continue;
			}
			const input = part.input;
			const questions =
				input?.questions ?? (input?.question ? [input.question] : []);
			const firstQuestion = questions[0];
			if (!firstQuestion) {
				continue;
			}
			const isAsync = isAsyncQuestionPart(part);
			if (!(isAsync || newestAssistant)) {
				continue;
			}
			if (!isQuestionPartOpen(part, answeredIds)) {
				continue;
			}
			const id = part.toolCallId ?? `question-${i}-${p}`;
			if (answeredIds.has(id)) {
				continue;
			}
			return {
				allowSkip: questionTool?.allowSkip ?? input?.allowSkip,
				async: isAsync,
				id,
				question: firstQuestion,
				questions,
				skipLabel: questionTool?.skipLabel ?? input?.skipLabel,
				submitLabel: questionTool?.submitLabel ?? input?.submitLabel,
				toolCallId: part.toolCallId,
				totalQuestions: questions.length,
			};
		}
		newestAssistant = false;
	}
	return null;
}

// Legacy component alias kept for compatibility.
export const AnAgentChat = AgentChat;
