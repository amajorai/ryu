import {
	ApprovalCard,
	type ApprovalCardAnswer,
	type ApprovalCardQuestion,
} from "@ryu/ui/components/agents/approval-card";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useEffect, useMemo, useState } from "react";
import type { QuestionAnswer, QuestionConfig } from "./question-prompt.tsx";
import styles from "./question-tool.module.css";

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

/** Map an in-thread `QuestionConfig` onto the beUI ApprovalCard question shape. */
function toApprovalQuestion(
	question: QuestionConfig,
	index: number
): ApprovalCardQuestion {
	const customLabel = question.customLabel;
	return {
		id: question.title || `question-${index}`,
		title: question.title,
		description: question.description,
		// `text` questions are free-form: surfaced as the custom answer input.
		multiple: question.kind === "multi",
		allowCustom: question.kind === "text" || question.allowCustom,
		customPlaceholder:
			question.kind === "text"
				? (question.placeholder ?? "Type your answer")
				: (question.customPlaceholder ?? customLabel),
		options: (question.options ?? []).map((option) => ({
			value: option.id,
			label: option.description
				? `${option.label} — ${option.description}`
				: option.label,
		})),
	};
}

/** Map a beUI answer back onto the QuestionAnswer contract the part expects. */
function fromApprovalAnswer(
	question: QuestionConfig,
	answer: ApprovalCardAnswer
): QuestionAnswer {
	if (question.kind === "text") {
		return { kind: "text", text: answer.custom ?? "" };
	}
	const selectedIds = answer.selected.filter((id) => id !== "__custom__");
	const customText = answer.custom?.trim();
	return {
		kind: question.kind,
		selectedIds,
		text: customText || undefined,
	};
}

export function QuestionTool({ part }: QuestionToolProps) {
	const [localIndex, setLocalIndex] = useState(part.input?.questionIndex ?? 1);
	const questions: QuestionConfig[] = part.input?.questions ?? [];
	const totalQuestions = part.input?.totalQuestions ?? questions.length;
	const isControlled = isNativeNumber(part.input?.questionIndex);
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
		if (isNativeNumber(part.input?.questionIndex)) {
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

	const summaryText = useMemo(() => {
		if (outputAnswer) {
			return formatAnswer(outputAnswer);
		}
		if (localAnswers[clampedIndex]) {
			return formatAnswer(localAnswers[clampedIndex]);
		}
		return "Response submitted";
	}, [outputAnswer, localAnswers, clampedIndex]);

	const approvalQuestions = useMemo(
		() => questions.map(toApprovalQuestion),
		[questions]
	);

	const goNext = () => {
		if (clampedIndex >= totalQuestions) {
			return;
		}
		part.input?.onNextQuestion?.();
		if (!isControlled) {
			setLocalIndex((prev) => Math.min(totalQuestions, prev + 1));
		}
	};

	return (
		<div className={styles.question}>
			<ApprovalCard
				defaultAnswers={Object.fromEntries(
					Object.entries(localAnswers)
						.filter(([, answer]) => answer && answer.kind !== "skip")
						.map(([index, answer]) => [
							questions[Number(index) - 1]?.title ?? index,
							{
								selected: answer.selectedIds ?? [],
								custom: answer.text,
							} satisfies ApprovalCardAnswer,
						])
				)}
				defaultStep={clampedIndex - 1}
				description="The agent needs an answer before it continues."
				onAnswersChange={(answers) => {
					// Keep localAnswers in sync so completion state and the summary stay
					// truthful as the user moves through the questions.
					const next: Record<number, QuestionAnswer> = {};
					for (const [title, answer] of Object.entries(answers)) {
						const idx = questions.findIndex((q) => q.title === title);
						if (idx >= 0) {
							next[idx + 1] = fromApprovalAnswer(questions[idx]!, answer);
						}
					}
					setLocalAnswers(next);
				}}
				onStepChange={(step) => {
					if (!isControlled) {
						setLocalIndex(step + 1);
					}
				}}
				onSubmit={(answers) => {
					// The primary action advances through questions; on the last one it
					// reports the answer to the part.
					if (clampedIndex < totalQuestions) {
						goNext();
						return;
					}
					const lastQuestion = questions[clampedIndex - 1];
					if (!lastQuestion) {
						return;
					}
					const answer = answers[lastQuestion.title];
					part.input?.onSubmitAnswer?.(
						answer ? fromApprovalAnswer(lastQuestion, answer) : { kind: "skip" }
					);
				}}
				questions={approvalQuestions}
				result={isComplete ? summaryText : undefined}
				status={isComplete ? "answered" : "pending"}
				submitLabel={part.input?.submitLabel ?? "Submit response"}
			/>
		</div>
	);
}
