"use client";

import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	MessageQuestionIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { useCallback, useState } from "react";
import type { InputBarProps } from "./input-bar-types.ts";
import { QuestionPrompt } from "./question/question-prompt.tsx";

/**
 * Pending question(s) rendered as a composer prompt card, with local or
 * host-driven navigation between questions.
 */
export function useComposerQuestionBar(
	questionBar: InputBarProps["questionBar"],
	voice: InputBarProps["voice"]
) {
	const [dismissedQuestionId, setDismissedQuestionId] = useState<string | null>(
		null
	);
	const [questionBarIndex, setQuestionBarIndex] = useState(1);

	const shouldShowQuestionBar = Boolean(
		questionBar && questionBar.id !== dismissedQuestionId
	);
	const questionBarData = questionBar;
	const questionSet = questionBarData?.questions ?? [];
	const hasQuestions = questionSet.length > 0;
	const derivedTotal = hasQuestions ? questionSet.length : 1;
	const totalQuestions = questionBarData?.totalQuestions ?? derivedTotal;
	const hasExternalQuestionNavigation = Boolean(
		questionBarData?.onPreviousQuestion || questionBarData?.onNextQuestion
	);
	const questionIndex = hasExternalQuestionNavigation
		? (questionBarData?.questionIndex ?? 1)
		: questionBarIndex;
	const clampedQuestionIndex = Math.max(
		1,
		Math.min(questionIndex, totalQuestions)
	);
	const activeQuestion = hasQuestions
		? questionSet[clampedQuestionIndex - 1]
		: undefined;
	const showQuestionNavigation = totalQuestions > 1;
	const canGoPrev = clampedQuestionIndex > 1;
	const canGoNext = clampedQuestionIndex < totalQuestions;

	const handleQuestionPrevious = useCallback(() => {
		if (!canGoPrev) {
			return;
		}
		if (questionBarData?.onPreviousQuestion) {
			questionBarData.onPreviousQuestion();
			return;
		}
		setQuestionBarIndex((prev) => Math.max(1, prev - 1));
	}, [canGoPrev, questionBarData]);

	const handleQuestionNext = useCallback(() => {
		if (!canGoNext) {
			return;
		}
		if (questionBarData?.onNextQuestion) {
			questionBarData.onNextQuestion();
			return;
		}
		setQuestionBarIndex((prev) => Math.min(totalQuestions, prev + 1));
	}, [canGoNext, questionBarData, totalQuestions]);

	const questionBarNode =
		shouldShowQuestionBar && activeQuestion ? (
			<div
				className="w-full overflow-hidden rounded-(--radius-os-icon-launcher) border border-border bg-background/80"
				data-composer-prompt="question"
			>
				<div className="flex h-7 items-center justify-between border-border border-b px-3 text-muted-foreground text-xs">
					<div className="inline-flex items-center gap-1.5">
						<HugeiconsIcon className="h-3.5 w-3.5" icon={MessageQuestionIcon} />
						Question
					</div>
					{showQuestionNavigation && (
						<div className="inline-flex items-center gap-1">
							<Button
								aria-label="Previous question"
								className="size-5"
								disabled={!canGoPrev}
								onClick={handleQuestionPrevious}
								radius="small"
								size="icon"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="h-3.5 w-3.5" icon={ArrowUp01Icon} />
							</Button>
							<span>
								{clampedQuestionIndex} of {totalQuestions}
							</span>
							<Button
								aria-label="Next question"
								className="size-5"
								disabled={!canGoNext}
								onClick={handleQuestionNext}
								radius="small"
								size="icon"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="h-3.5 w-3.5" icon={ArrowDown01Icon} />
							</Button>
						</div>
					)}
				</div>
				<QuestionPrompt
					allowSkip={questionBarData?.allowSkip}
					key={`${clampedQuestionIndex}-${activeQuestion?.title ?? "question"}`}
					onSkip={() => {
						questionBarData?.onSkip?.();
					}}
					onSubmit={(answer) => {
						questionBarData?.onSubmit(answer);
						// `null` is this state's "nothing dismissed" value; an absent
						// question has no id to record.
						setDismissedQuestionId(questionBarData?.id ?? null);
					}}
					questionIndex={clampedQuestionIndex}
					questions={questionSet}
					skipLabel={questionBarData?.skipLabel}
					submitLabel={questionBarData?.submitLabel}
					totalQuestions={totalQuestions}
					voice={voice}
				/>
			</div>
		) : null;

	return { questionBarData, questionBarNode };
}
