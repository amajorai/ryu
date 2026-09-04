"use client";

import { Button } from "@ryu/ui/components/button";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	ChatDisplayPrefsProvider,
	useChatDisplayPrefs,
} from "./chat-display-prefs.tsx";
import { deriveContextUsage } from "./context-usage.tsx";
import { type SuggestionItem, Suggestions } from "./input/suggestions.tsx";
import { InputBar } from "./input-bar.tsx";
import { MessageList } from "./message-list.tsx";
import { ComposerQuotePreview } from "./quote.tsx";
import type { AgentChatProps } from "./types.ts";
import { useDeferredComposerPrompt } from "./use-deferred-question.ts";

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
	onBranch,
	onAgentUiSubmit,
	onEditMessage,
	onRegenerateMessage,
	onRetryError,
	onRetryGeneration,
	messageActions,
	messageActionStates,
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
	voiceMode,
	infoBar,
	onComposerMenuSelect,
	onComposerResize,
	currentUser,
	seedDraft,
	onSeedDraftConsumed,
	onDraftChange,
	suggestions,
	followUps,
	emptyStatePosition = "default",
	emptySuggestionsPlacement = "input",
	emptySuggestionsPosition = "top",
	emptyStateHeader,
	emptyStateFooter,
	historyLoading,
	historyError,
	hasOlderMessages,
	loadingOlderMessages,
	onLoadOlderMessages,
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
	onOpenContext,
	draftControls,
}: AgentChatProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const { animationsEnabled } = useChatDisplayPrefs();
	const reduceMotion = !animationsEnabled || (useReducedMotion() ?? false);
	const [draft, setDraft] = useState("");
	const draftTouchedRef = useRef(false);
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
			draft.length === 0
		) {
			seededValueRef.current = seedDraft;
			setDraft(seedDraft);
			onSeedDraftConsumed?.();
		}
	}, [draft, onSeedDraftConsumed, seedDraft]);

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
	const contextMeter = useMemo(
		() => deriveContextUsage(messages, contextSize) ?? undefined,
		[messages, contextSize]
	);

	// A failed request is shown as a synthetic trailing assistant message. Built
	// in a memo rather than inline in the JSX because a fresh array literal there
	// hands MessageList a new `messages` identity on EVERY render for as long as
	// an error is on screen — which invalidates normalizeMessages /
	// groupMessagesIntoTurns / the TOC continuously, and re-arms the pinned-message
	// measuring effect every pass (the escalation path to React error #185).
	const listMessages = useMemo(
		() =>
			error
				? [
						...messages,
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
						} as unknown as (typeof messages)[number],
					]
				: messages,
		[error, messages]
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
		!(error || isPlaceholder) && messages.length === 0 && !isStreaming;
	const isCenteredEmptyState = isEmpty && emptyStatePosition === "center";
	// The placeholder replaces the transcript only while there is nothing to show;
	// a re-fetch over an already-rendered thread must not blank it.
	const showPlaceholder = isPlaceholder && !error && messages.length === 0;

	const pendingQuestion = findPendingQuestion(messages, questionTool);
	const {
		markComposerActivity: markQuestionActivity,
		markComposerIdle: markQuestionIdle,
		visiblePrompt: visiblePendingQuestion,
	} = useDeferredComposerPrompt(pendingQuestion);
	const {
		markComposerActivity: markPromptActivity,
		markComposerIdle: markPromptIdle,
		visiblePrompt: visibleComposerPrompt,
	} = useDeferredComposerPrompt(composerPrompt);
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
			className={cn(
				"w-full justify-center",
				emptySuggestionsPosition === "top" ? "mb-3" : "mt-3",
				suggestionConfig.className
			)}
			disabled={isStreaming}
			itemClassName={cn("h-8 rounded-md px-3", suggestionConfig.itemClassName)}
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
					itemClassName="h-8 rounded-full px-3"
					items={followUpItems}
					onSelect={followUps.onSelect}
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
				quote ? (
					<ComposerQuotePreview onDismiss={onClearQuote} text={quote} />
				) : undefined
			}
			composerMenuGroups={composerMenuGroups}
			composerPrompt={visibleComposerPrompt ?? undefined}
			contextMeter={contextMeter}
			contextMeterOnOpen={onOpenContext}
			disabled={composerDisabled}
			draftControls={resolvedDraftControls}
			infoBar={infoBar}
			isDragOver={attachments?.isDragOver}
			onAttach={attachments?.onAttach}
			onChange={handleDraftChange}
			onComposerMenuSelect={onComposerMenuSelect}
			onHeightChange={onComposerResize}
			onPaste={attachments?.onPaste}
			onRemoveFile={attachments?.onRemoveFile}
			onRemoveImage={attachments?.onRemoveImage}
			onSend={onSend}
			onStop={onStop}
			placeholder={isEmpty ? "Send a message" : "Ask a follow up"}
			placeholderSuggestion={
				(followUpItems[0] ?? suggestionConfig.items[0])?.label
			}
			questionBar={
				visiblePendingQuestion
					? {
							id: visiblePendingQuestion.id,
							questions: visiblePendingQuestion.questions,
							questionIndex: visiblePendingQuestion.questionIndex,
							totalQuestions: visiblePendingQuestion.totalQuestions,
							onPreviousQuestion: visiblePendingQuestion.onPreviousQuestion,
							onNextQuestion: visiblePendingQuestion.onNextQuestion,
							submitLabel: visiblePendingQuestion.submitLabel,
							skipLabel: visiblePendingQuestion.skipLabel,
							allowSkip: visiblePendingQuestion.allowSkip,
							onSubmit: (answer) => {
								questionTool?.onAnswer?.({
									toolCallId: visiblePendingQuestion.toolCallId,
									question:
										visiblePendingQuestion.questions[
											visiblePendingQuestion.questionIndex
												? visiblePendingQuestion.questionIndex - 1
												: 0
										],
									answer,
								});
							},
						}
					: undefined
			}
			seamless={voiceMode?.active}
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
	const voiceModeNode = voiceMode?.active
		? voiceMode.render(inputBarNode)
		: null;
	const renderedComposer = voiceMode?.active ? null : inputBarNode;

	let transcriptNode: ReactNode;
	if (showPlaceholder) {
		transcriptNode = (
			<HistoryPlaceholder
				className={classNames?.messageList}
				error={historyError}
			/>
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
				className={classNames?.messageList}
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
				initialScrollBehavior={initialScrollBehavior}
				loadingOlderMessages={loadingOlderMessages}
				mentionItems={mentionItems}
				messageActionStates={messageActionStates}
				messageActions={messageActions}
				messages={listMessages}
				onAgentUiSubmit={onAgentUiSubmit}
				onBranch={onBranch}
				onContributedMessageAction={onContributedMessageAction}
				onContributedSelectionAction={onContributedSelectionAction}
				onEditMessage={onEditMessage}
				onLoadOlderMessages={onLoadOlderMessages}
				onOpenFile={onOpenFile}
				onOpenLink={onOpenLink}
				onOpenMention={onOpenMention}
				onQuote={onQuote}
				onRegenerateMessage={onRegenerateMessage}
				onReply={onReply}
				onRetryError={onRetryError}
				onRetryGeneration={onRetryGeneration}
				onReviewFileEdits={onReviewFileEdits}
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
					{renderedComposer}
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
			data-chat-motion={reduceMotion ? "off" : "on"}
			data-chat-state={isCenteredEmptyState ? "empty" : "active"}
			ref={rootRef}
			style={style}
		>
			{chatStage}
		</div>
	);
	const chatSurface = (
		<>
			{chatNode}
			{voiceModeNode}
		</>
	);

	return density ? (
		<ChatDisplayPrefsProvider value={{ density }}>
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
	className,
	error,
}: {
	className?: string;
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
					className
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
				className
			)}
		>
			<div className="flex justify-end">
				<Skeleton className="h-9 w-[45%] rounded-2xl" />
			</div>
			<div className="flex gap-3">
				<Skeleton className="h-7 w-7 shrink-0 rounded-full" />
				<div className="flex w-full flex-col gap-2">
					<Skeleton className="h-4 w-[85%] rounded-md" />
					<Skeleton className="h-4 w-[70%] rounded-md" />
					<Skeleton className="h-4 w-[45%] rounded-md" />
				</div>
			</div>
			<div className="flex justify-end">
				<Skeleton className="h-9 w-[30%] rounded-2xl" />
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

function findPendingQuestion(
	messages: AgentChatProps["messages"],
	questionTool: AgentChatProps["questionTool"]
) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}
		const parts = message.parts ?? [];
		for (let p = parts.length - 1; p >= 0; p -= 1) {
			const part = parts[p] as {
				type?: string;
				toolCallId?: string;
				input?: {
					questions?: import("./question/question-prompt").QuestionConfig[];
					question?: import("./question/question-prompt").QuestionConfig;
					questionIndex?: number;
					totalQuestions?: number;
					onPreviousQuestion?: () => void;
					onNextQuestion?: () => void;
					submitLabel?: string;
					skipLabel?: string;
					allowSkip?: boolean;
				};
				output?: {
					answer?: import("./question/question-prompt").QuestionAnswer;
				};
			};
			if (part?.type !== "tool-Question") {
				continue;
			}
			const input = part.input;
			const questions = input?.questions ?? [];
			const firstQuestion = questions[0] ?? input?.question;
			if (!firstQuestion) {
				continue;
			}
			if (part.output?.answer) {
				return null;
			}
			return {
				id: part.toolCallId ?? `question-${i}-${p}`,
				toolCallId: part.toolCallId,
				questions,
				question: firstQuestion,
				questionIndex: input?.questionIndex,
				totalQuestions:
					input?.totalQuestions ??
					(questions.length > 0 ? questions.length : undefined),
				onPreviousQuestion: input?.onPreviousQuestion,
				onNextQuestion: input?.onNextQuestion,
				submitLabel: questionTool?.submitLabel ?? input?.submitLabel,
				skipLabel: questionTool?.skipLabel ?? input?.skipLabel,
				allowSkip: questionTool?.allowSkip ?? input?.allowSkip,
			};
		}
	}
	return null;
}

// Legacy component alias kept for compatibility.
export const AnAgentChat = AgentChat;
