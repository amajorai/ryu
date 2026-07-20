import { Button } from "@ryu/ui/components/button";
import {
	IconChevronDown,
	IconChevronUp,
	IconMessageCircleQuestion,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import type { QuestionAnswer, QuestionConfig } from "./question-prompt.tsx";
import { QuestionPrompt } from "./question-prompt.tsx";

export interface QuestionToolPart {
	input?: {
		questions: QuestionConfig[];
		questionIndex?: number;
		totalQuestions?: number;
		onPreviousQuestion?: () => void;
		onNextQuestion?: () => void;
		submitLabel?: string;
		nextLabel?: string;
		skipLabel?: string;
		allowSkip?: boolean;
		onSubmitAnswer?: (answer: QuestionAnswer) => void;
	};
	output?: {
		answer?: QuestionAnswer;
	};
	state?: string;
	toolCallId?: string;
	type: string;
}

export interface QuestionToolProps {
	chatStatus?: string;
	part: QuestionToolPart;
}

function formatAnswer(answer: QuestionAnswer) {
	if (answer.kind === "skip") {
		return "Skipped";
	}
	if (answer.kind === "text") {
		return answer.text || "Answered";
	}
	const ids = answer.selectedIds?.length ? answer.selectedIds.join(", ") : "";
	if (answer.text) {
		return ids ? `${ids} (${answer.text})` : answer.text;
	}
	return ids || "Answered";
}

export function QuestionTool({ part }: QuestionToolProps) {
	const [localIndex, setLocalIndex] = useState(part.input?.questionIndex ?? 1);
	const questions: QuestionConfig[] = part.input?.questions ?? [];
	const totalQuestions = part.input?.totalQuestions ?? questions.length;
	const isControlled = typeof part.input?.questionIndex === "number";
	const questionIndex = isControlled
		? (part.input?.questionIndex ?? 1)
		: questions.length > 0
			? localIndex
			: (part.input?.questionIndex ?? 1);
	const clampedIndex = Math.max(1, Math.min(questionIndex, totalQuestions));
	const question = questions[clampedIndex - 1];
	const [localAnswers, setLocalAnswers] = useState<
		Record<number, QuestionAnswer>
	>({});

	useEffect(() => {
		if (typeof part.input?.questionIndex === "number") {
			setLocalIndex(part.input.questionIndex);
		}
	}, [part.input?.questionIndex]);

	useEffect(() => {
		setLocalAnswers({});
		setLocalIndex(part.input?.questionIndex ?? 1);
	}, [part.input?.questionIndex]);

	if (!question) {
		return null;
	}

	const outputAnswer = part.output?.answer;
	const answeredCount = Object.keys(localAnswers).length;
	const isComplete =
		totalQuestions === 1
			? !!outputAnswer || answeredCount >= 1
			: totalQuestions > 0 && answeredCount >= totalQuestions;
	const showNavigation = totalQuestions > 1 && !isComplete;
	const canGoPrev = clampedIndex > 1;
	const canGoNext = clampedIndex < totalQuestions;
	const summaryAnswers = useMemo(() => {
		if (!isComplete || totalQuestions <= 1) {
			return [];
		}
		return Array.from({ length: totalQuestions }, (_, idx) => ({
			index: idx + 1,
			answer: localAnswers[idx + 1],
		}));
	}, [isComplete, localAnswers, totalQuestions]);
	const summaryText = useMemo(() => {
		if (!isComplete) {
			return "";
		}
		if (summaryAnswers.length > 0) {
			return summaryAnswers
				.map(
					(item) =>
						`${item.index}: ${item.answer ? formatAnswer(item.answer) : "Pending"}`
				)
				.join(" • ");
		}
		if (outputAnswer) {
			return formatAnswer(outputAnswer);
		}
		if (localAnswers[clampedIndex]) {
			return formatAnswer(localAnswers[clampedIndex]);
		}
		return "Pending";
	}, [isComplete, summaryAnswers, outputAnswer, localAnswers, clampedIndex]);

	const goPrev = () => {
		if (!canGoPrev) {
			return;
		}
		part.input?.onPreviousQuestion?.();
		if (!isControlled) {
			setLocalIndex((prev) => Math.max(1, prev - 1));
		}
	};

	const goNext = () => {
		if (!canGoNext) {
			return;
		}
		part.input?.onNextQuestion?.();
		if (!isControlled) {
			setLocalIndex((prev) => Math.min(totalQuestions, prev + 1));
		}
	};

	return (
		<div className="overflow-hidden rounded-[var(--radius)] bg-muted">
			<div className="flex h-7 items-center justify-between px-3 text-muted-foreground text-xs">
				<div className="inline-flex items-center gap-1.5">
					<IconMessageCircleQuestion className="h-3.5 w-3.5" />
					Question
				</div>
				{showNavigation && (
					<div className="inline-flex items-center gap-1">
						<Button
							aria-label="Previous question"
							className="size-5 rounded-sm"
							disabled={!canGoPrev}
							onClick={goPrev}
							size="icon"
							type="button"
							variant="ghost"
						>
							<IconChevronUp className="h-3.5 w-3.5" />
						</Button>
						<span>
							{clampedIndex} of {totalQuestions}
						</span>
						<Button
							aria-label="Next question"
							className="size-5 rounded-sm"
							disabled={!canGoNext}
							onClick={goNext}
							size="icon"
							type="button"
							variant="ghost"
						>
							<IconChevronDown className="h-3.5 w-3.5" />
						</Button>
					</div>
				)}
			</div>

			{isComplete ? (
				<div className="bg-background px-3 py-2 text-muted-foreground text-xs">
					{summaryText}
				</div>
			) : (
				<QuestionPrompt
					allowSkip={part.input?.allowSkip}
					initialAnswer={localAnswers[clampedIndex]}
					key={`${clampedIndex}-${question.title}`}
					nextLabel={part.input?.nextLabel}
					onSubmit={(nextAnswer) => {
						setLocalAnswers((prev) => ({
							...prev,
							[clampedIndex]: nextAnswer,
						}));
						part.input?.onSubmitAnswer?.(nextAnswer);
						if (clampedIndex < totalQuestions) {
							goNext();
						}
					}}
					questionIndex={clampedIndex}
					questions={questions}
					skipLabel={part.input?.skipLabel}
					submitLabel={part.input?.submitLabel}
					totalQuestions={totalQuestions}
				/>
			)}
		</div>
	);
}
