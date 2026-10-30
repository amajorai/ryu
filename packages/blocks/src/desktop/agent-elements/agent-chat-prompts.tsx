import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useMemo, useState } from "react";
import type { useAgentChatDraft } from "./agent-chat-draft.ts";
import {
	findPendingQuestion,
	resolveSuggestions,
	sessionDismissedTasks,
} from "./agent-chat-helpers.tsx";
import type { AgentChatBaseScope } from "./agent-chat-scope.ts";
import { type SuggestionItem, Suggestions } from "./input/suggestions.tsx";
import { answeredQuestionIds } from "./question/async-question.ts";
import type { QuestionAnswer } from "./question/question-prompt.tsx";
import {
	latestSuggestedTask,
	type SuggestedTask,
} from "./tools/suggested-task.ts";
import { SuggestedTaskCard } from "./tools/suggested-task-card.tsx";
import { useDeferredComposerPrompt } from "./use-deferred-question.ts";

export type UseAgentChatPromptsInput = AgentChatBaseScope &
	ReturnType<typeof useAgentChatDraft>;

/** Pending questions, suggestions, follow-ups and the suggested task. */
export function useAgentChatPrompts({
	messages,
	questionTool,
	promptsPaused,
	composerPrompt,
	setDraftFromUser,
	suggestions,
	emptySuggestionsPlacement,
	isCenteredEmptyState,
	isStreaming,
	emptySuggestionsPosition,
	isEmpty,
	emptyStateFooter,
	followUps,
	error,
	status,
	taskSuggestions,
}: UseAgentChatPromptsInput) {
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
	return {
		setLocallyAnsweredQuestions,
		questionProgress,
		setQuestionProgress,
		visiblePendingQuestion,
		visibleComposerPrompt,
		handleDraftChange,
		suggestionConfig,
		showInputSuggestions,
		emptySuggestionsNode,
		emptyStateFooterNode,
		followUpItems,
		followUpsNode,
		suggestedTaskNode,
	} as const;
}
