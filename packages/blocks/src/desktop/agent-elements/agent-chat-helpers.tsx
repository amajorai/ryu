import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { useAgentAvailability } from "../agent-availability.tsx";
import {
	isAsyncQuestionPart,
	isQuestionPartOpen,
} from "./question/async-question.ts";
import type {
	QuestionAnswer,
	QuestionConfig,
} from "./question/question-prompt.tsx";
import type { AgentChatProps } from "./types.ts";

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
export const sessionDismissedTasks = new Set<string>();

export const CHAT_LAYOUT_TRANSITION = {
	damping: 34,
	mass: 0.75,
	stiffness: 420,
	type: "spring" as const,
};

/**
 * What the transcript area shows while a restored thread's history is still in
 * flight, or when it could not be fetched at all. Deliberately transcript-shaped
 * rather than a spinner: the point is that this tab is a CONVERSATION that has
 * not arrived, not an empty one. The composer stays mounted below it (rendered by
 * the caller), so the tab never reads as dead.
 */
export function HistoryPlaceholder({
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
		// The shared `Empty` primitive: one title, one line of copy and one
		// small outline Retry — no card, no illustration.
		return (
			<div
				className={cn(
					"flex min-h-0 flex-1 items-center justify-center px-4 py-4",
					classNames?.messageList
				)}
			>
				<Empty className="flex-none gap-3 py-12">
					<EmptyHeader className="gap-1">
						<EmptyTitle className="font-sans text-sm tracking-normal">
							{error.title}
						</EmptyTitle>
						{error.description ? (
							<EmptyDescription className="text-(length:--text-detail) leading-(--text-detail--line-height)">
								{error.description}
							</EmptyDescription>
						) : null}
					</EmptyHeader>
					{error.onRetry ? (
						<Button onClick={error.onRetry} size="sm" variant="outline">
							Try again
						</Button>
					) : null}
				</Empty>
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

export function resolveSuggestions(suggestions: AgentChatProps["suggestions"]) {
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

export function availabilityInfoDescription(
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
export function buildQuestionBar({
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
