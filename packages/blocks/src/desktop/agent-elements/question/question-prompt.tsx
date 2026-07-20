import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useMemo, useState } from "react";

export interface QuestionOption {
	description?: string;
	id: string;
	label: string;
}

export interface QuestionConfig {
	allowCustom?: boolean;
	customLabel?: string;
	customPlaceholder?: string;
	description?: string;
	kind: "single" | "multi" | "text";
	maxSelections?: number;
	minSelections?: number;
	options?: QuestionOption[];
	placeholder?: string;
	title: string;
}

export interface QuestionAnswer {
	kind: "single" | "multi" | "text" | "skip";
	selectedIds?: string[];
	text?: string;
}

const QUESTION_CUSTOM_ID = "__custom__";

function optionBadge(idx: number) {
	return String.fromCharCode(65 + idx);
}

export interface QuestionPromptProps {
	allowSkip?: boolean;
	className?: string;
	initialAnswer?: QuestionAnswer;
	/** Label for the primary action when there are more questions ahead
	 *  (default "Next"). The host (e.g. QuestionTool) is expected to advance
	 *  to the next question after onSubmit fires. */
	nextLabel?: string;
	onNextQuestion?: () => void;
	onPreviousQuestion?: () => void;
	onSkip?: () => void;
	onSubmit: (answer: QuestionAnswer) => void;
	questionIndex?: number;
	questions: QuestionConfig[];
	skipLabel?: string;
	/** Label for the primary action on the LAST question (default "Send"). */
	submitLabel?: string;
	totalQuestions?: number;
}

export function QuestionPrompt({
	questions,
	questionIndex = 1,
	totalQuestions,
	onPreviousQuestion,
	onNextQuestion,
	submitLabel = "Send",
	nextLabel = "Next",
	skipLabel = "Skip",
	allowSkip = true,
	initialAnswer,
	onSubmit,
	onSkip,
	className,
}: QuestionPromptProps) {
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [customText, setCustomText] = useState("");
	const [textValue, setTextValue] = useState("");
	const resolvedTotal = totalQuestions ?? questions.length;
	const clampedIndex = Math.max(1, Math.min(questionIndex, resolvedTotal));
	const activeQuestion = questions[clampedIndex - 1];
	const customEnabled = activeQuestion?.allowCustom ?? false;
	const showNav =
		resolvedTotal > 1 && (!!onPreviousQuestion || !!onNextQuestion);
	const canGoPrev = clampedIndex > 1;
	const canGoNext = clampedIndex < resolvedTotal;
	const isLastQuestion = clampedIndex >= resolvedTotal;
	const primaryLabel = isLastQuestion ? submitLabel : nextLabel;

	useEffect(() => {
		if (!initialAnswer || initialAnswer.kind === "skip") {
			setSelectedIds([]);
			setCustomText("");
			setTextValue("");
			return;
		}

		if (activeQuestion?.kind === "text") {
			setSelectedIds([]);
			setCustomText("");
			setTextValue(initialAnswer.text ?? "");
			return;
		}

		const nextSelected = new Set(initialAnswer.selectedIds ?? []);
		const nextCustomText = initialAnswer.text ?? "";
		if (customEnabled && nextCustomText.trim().length > 0) {
			nextSelected.add(QUESTION_CUSTOM_ID);
		}
		setSelectedIds(Array.from(nextSelected));
		setCustomText(nextCustomText);
		setTextValue("");
	}, [
		activeQuestion?.kind,
		customEnabled,
		initialAnswer?.kind,
		initialAnswer?.text,
		initialAnswer.selectedIds,
		initialAnswer,
	]);

	const canSubmit = useMemo(() => {
		if (activeQuestion?.kind === "text") {
			return textValue.trim().length > 0;
		}

		const selectedNonCustom = selectedIds.filter(
			(id) => id !== QUESTION_CUSTOM_ID
		).length;
		const hasCustomText = customText.trim().length > 0;
		const total = selectedNonCustom + (hasCustomText ? 1 : 0);

		if (activeQuestion?.kind === "single") {
			return total === 1;
		}

		const min = activeQuestion?.minSelections ?? 1;
		const max = activeQuestion?.maxSelections;
		if (total < min) {
			return false;
		}
		if (typeof max === "number" && total > max) {
			return false;
		}
		return total > 0;
	}, [
		activeQuestion?.kind,
		activeQuestion?.minSelections,
		activeQuestion?.maxSelections,
		selectedIds,
		customText,
		textValue,
	]);

	const toggleMulti = (id: string) => {
		setSelectedIds((prev) =>
			prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
		);
	};

	const handleSingleSelect = (id: string) => {
		setSelectedIds([id]);
	};

	const handleCustomTextChange = (nextValue: string) => {
		setCustomText(nextValue);
		if (!activeQuestion) {
			return;
		}
		if (activeQuestion.kind === "single") {
			setSelectedIds(nextValue.trim().length > 0 ? [QUESTION_CUSTOM_ID] : []);
			return;
		}
		setSelectedIds((prev) => {
			const hasCustom = prev.includes(QUESTION_CUSTOM_ID);
			if (nextValue.trim().length > 0 && !hasCustom) {
				return [...prev, QUESTION_CUSTOM_ID];
			}
			if (nextValue.trim().length === 0 && hasCustom) {
				return prev.filter((id) => id !== QUESTION_CUSTOM_ID);
			}
			return prev;
		});
	};

	const handleSubmit = () => {
		if (!(canSubmit && activeQuestion)) {
			return;
		}
		if (activeQuestion.kind === "text") {
			onSubmit({ kind: "text", text: textValue.trim() });
			return;
		}

		const selectedNonCustom = selectedIds.filter(
			(id) => id !== QUESTION_CUSTOM_ID
		);
		const answerText = customText.trim() || undefined;
		onSubmit({
			kind: activeQuestion.kind,
			selectedIds: selectedNonCustom,
			text: answerText || undefined,
		});
	};

	const handleSkip = () => {
		onSkip?.();
		onSubmit({ kind: "skip" });
	};

	if (!activeQuestion) {
		return null;
	}

	return (
		<div className={cn("space-y-2 bg-background px-3 py-2", className)}>
			<div
				className="flex items-center justify-between gap-px"
				data-total-questions={resolvedTotal}
			>
				<div className="flex items-center gap-2 text-foreground text-sm">
					<span className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] px-1 font-medium text-muted-foreground text-sm">
						{clampedIndex}
					</span>
					<span>{activeQuestion.title}</span>
				</div>
			</div>

			{activeQuestion.kind !== "text" &&
				(activeQuestion.options?.length ?? 0) > 0 && (
					<div className="space-y-px">
						{activeQuestion.options?.map((option, idx) => {
							const checked = selectedIds.includes(option.id);
							return (
								<Button
									className="-mx-2 h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left font-normal"
									key={option.id}
									onClick={() => {
										if (activeQuestion.kind === "single") {
											handleSingleSelect(option.id);
											if (customEnabled) {
												setCustomText("");
											}
										} else {
											toggleMulti(option.id);
										}
									}}
									type="button"
									variant="ghost"
								>
									<span
										className={cn(
											"inline-flex h-5 min-w-5 items-center justify-center rounded-sm border px-1 font-medium text-sm",
											checked
												? "border-primary bg-primary text-primary-foreground"
												: "border-border bg-transparent text-muted-foreground"
										)}
									>
										{optionBadge(idx)}
									</span>
									<span className="text-foreground text-sm">
										{option.label}
										{option.description && (
											<span className="text-muted-foreground">
												{" "}
												{option.description}
											</span>
										)}
									</span>
								</Button>
							);
						})}

						{customEnabled && (
							<div className="flex items-center gap-2 pt-1">
								<span
									className={cn(
										"inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border px-1 font-medium text-sm",
										selectedIds.includes(QUESTION_CUSTOM_ID)
											? "border-primary bg-primary text-primary-foreground"
											: "border-border bg-transparent text-muted-foreground"
									)}
								>
									{optionBadge(activeQuestion.options?.length)}
								</span>
								<input
									className="h-7 w-full rounded-md border border-border bg-background px-2 text-foreground text-sm"
									onChange={(event) =>
										handleCustomTextChange(event.target.value)
									}
									placeholder={
										activeQuestion.customPlaceholder ?? "Type your answer"
									}
									value={customText}
								/>
							</div>
						)}
					</div>
				)}

			{activeQuestion.kind === "text" && (
				<textarea
					className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-foreground text-sm"
					onChange={(event) => setTextValue(event.target.value)}
					placeholder={activeQuestion.placeholder ?? "Type your answer"}
					rows={3}
					value={textValue}
				/>
			)}

			<div
				className={cn(
					"flex items-center gap-1.5",
					showNav ? "justify-between" : "justify-end"
				)}
			>
				{showNav && (
					<div className="flex items-center gap-1.5">
						{onPreviousQuestion && (
							<Button
								className="h-6 px-2 text-muted-foreground hover:text-foreground"
								disabled={!canGoPrev}
								onClick={onPreviousQuestion}
								size="sm"
								type="button"
								variant="ghost"
							>
								Previous
							</Button>
						)}
						{onNextQuestion && (
							<Button
								className="h-6 px-2 text-muted-foreground hover:text-foreground"
								disabled={!canGoNext}
								onClick={onNextQuestion}
								size="sm"
								type="button"
								variant="ghost"
							>
								Next
							</Button>
						)}
					</div>
				)}
				<div className="flex items-center justify-end gap-1.5">
					{allowSkip && (
						<Button
							className="h-6 px-2 text-muted-foreground hover:text-foreground"
							onClick={handleSkip}
							size="sm"
							type="button"
							variant="ghost"
						>
							{skipLabel}
						</Button>
					)}
					<Button
						className="h-6 px-2.5"
						disabled={!canSubmit}
						onClick={handleSubmit}
						size="sm"
						type="button"
					>
						{primaryLabel}
					</Button>
				</div>
			</div>
		</div>
	);
}
