"use client";

import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveContextUsage } from "./context-usage.tsx";
import { type SuggestionItem, Suggestions } from "./input/suggestions.tsx";
import { InputBar } from "./input-bar.tsx";
import { MessageList } from "./message-list.tsx";
import { ComposerQuotePreview } from "./quote.tsx";
import type { AgentChatProps } from "./types.ts";

export function AgentChat({
	messages,
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
	onEditMessage,
	onRegenerateMessage,
	onFeedback,
	feedback,
	onSelectVersion,
	versions,
	onSpeak,
	onQuote,
	onOpenFile,
	quote,
	onClearQuote,
	initialScrollBehavior,
	enableImagePreview,
	assistantAvatar,
	assistantName,
	seedDraft,
	suggestions,
	followUps,
	emptyStatePosition = "default",
	emptySuggestionsPlacement = "input",
	emptySuggestionsPosition = "top",
	emptyStateHeader,
	emptyStateFooter,
	questionTool,
	historyNotice,
	className,
	style,
	contextSize,
}: AgentChatProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [draft, setDraft] = useState("");

	// Apply a composer seed (e.g. from a deep link) once per distinct value, so a
	// pre-filled prompt lands in the textarea without clobbering later edits.
	const seededValueRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (seedDraft && seedDraft !== seededValueRef.current) {
			seededValueRef.current = seedDraft;
			setDraft(seedDraft);
		}
	}, [seedDraft]);

	const ResolvedInputBar = slots?.InputBar ?? InputBar;

	// Context-window meter for the composer: the fullness of THIS conversation,
	// derived from the latest turn's usage stats. The denominator prefers an
	// ACP-reported window, else the model's `contextSize` (launch config /
	// models.dev). Null (no meter) until a turn reports usage — it is live-only.
	const contextMeter = useMemo(
		() => deriveContextUsage(messages, contextSize) ?? undefined,
		[messages, contextSize]
	);

	const isEmpty = !error && messages.length === 0;
	const isCenteredEmptyState = isEmpty && emptyStatePosition === "center";

	const pendingQuestion = findPendingQuestion(messages, questionTool);
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
		setDraft(item.value ?? item.label);
	};

	const emptySuggestionsNode = showEmptySuggestions ? (
		<Suggestions
			className={cn(
				"w-full justify-center",
				emptySuggestionsPosition === "top" ? "mb-3" : "mt-3",
				suggestionConfig.className
			)}
			disabled={status === "streaming" || status === "submitted"}
			itemClassName={cn("h-8 rounded-md px-3", suggestionConfig.itemClassName)}
			items={suggestionConfig.items}
			onSelect={handleEmptySuggestionSelect}
		/>
	) : null;

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
			composerHeader={
				quote ? (
					<ComposerQuotePreview onDismiss={onClearQuote} text={quote} />
				) : undefined
			}
			contextMeter={contextMeter}
			isDragOver={attachments?.isDragOver}
			onAttach={attachments?.onAttach}
			onChange={setDraft}
			onPaste={attachments?.onPaste}
			onRemoveFile={attachments?.onRemoveFile}
			onRemoveImage={attachments?.onRemoveImage}
			onSend={onSend}
			onStop={onStop}
			placeholder={isEmpty ? "Send a message..." : "Ask a follow up"}
			questionBar={
				pendingQuestion
					? {
							id: pendingQuestion.id,
							questions: pendingQuestion.questions,
							questionIndex: pendingQuestion.questionIndex,
							totalQuestions: pendingQuestion.totalQuestions,
							onPreviousQuestion: pendingQuestion.onPreviousQuestion,
							onNextQuestion: pendingQuestion.onNextQuestion,
							submitLabel: pendingQuestion.submitLabel,
							skipLabel: pendingQuestion.skipLabel,
							allowSkip: pendingQuestion.allowSkip,
							onSubmit: (answer) => {
								questionTool?.onAnswer?.({
									toolCallId: pendingQuestion.toolCallId,
									question:
										pendingQuestion.questions[
											pendingQuestion.questionIndex
												? pendingQuestion.questionIndex - 1
												: 0
										],
									answer,
								});
							},
						}
					: undefined
			}
			status={status}
			suggestions={showInputSuggestions ? suggestions : []}
			value={draft}
		/>
	);

	return (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col",
				classNames?.root,
				className
			)}
			ref={rootRef}
			style={style}
		>
			{isCenteredEmptyState ? (
				<div className="flex min-h-0 flex-1 items-center justify-center px-4 py-4">
					<div className="w-full max-w-[720px]">
						{emptyStateHeader}
						{emptySuggestionsPosition === "top" ? emptySuggestionsNode : null}
						{inputBarNode}
						{emptySuggestionsPosition === "bottom"
							? emptySuggestionsNode
							: null}
						{emptyStateFooter}
					</div>
				</div>
			) : (
				<MessageList
					assistantAvatar={assistantAvatar}
					assistantName={assistantName}
					className={classNames?.messageList}
					classNames={classNames}
					contextSize={contextSize}
					enableImagePreview={enableImagePreview}
					feedback={feedback}
					historyNotice={historyNotice}
					initialScrollBehavior={initialScrollBehavior}
					messages={
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
							: messages
					}
					onBranch={onBranch}
					onEditMessage={onEditMessage}
					onFeedback={onFeedback}
					onOpenFile={onOpenFile}
					onQuote={onQuote}
					onRegenerateMessage={onRegenerateMessage}
					onSelectVersion={onSelectVersion}
					onSpeak={onSpeak}
					showCopyToolbar={showCopyToolbar}
					slots={slots}
					status={status}
					suppressQuestionTool={Boolean(pendingQuestion)}
					toolRenderers={toolRenderers}
					versions={versions}
				/>
			)}
			{isCenteredEmptyState ? null : (
				<>
					{followUpsNode}
					{inputBarNode}
				</>
			)}
		</div>
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
