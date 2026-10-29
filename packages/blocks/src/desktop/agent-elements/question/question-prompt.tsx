import { Button } from "@ryu/ui/components/button";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VoiceInputButton } from "../input/voice-input-button.tsx";
import { useVoiceRecorder } from "../useVoiceRecorder.ts";

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

export interface QuestionPromptVoice {
	disabled?: boolean;
	transcribe: (audio: Blob) => Promise<string>;
}

const QUESTION_CUSTOM_ID = "__custom__";
const noopTranscribe = async (): Promise<string> => "";

function appendVoiceText(current: string, transcript: string) {
	const next = transcript.trim();
	if (!next) {
		return current;
	}
	const base = current.trim();
	return base ? `${base} ${next}` : next;
}

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
	voice?: QuestionPromptVoice;
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
	voice,
}: QuestionPromptProps) {
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [customText, setCustomText] = useState("");
	const [textValue, setTextValue] = useState("");
	const customTextRef = useRef(customText);
	customTextRef.current = customText;
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

	const handleCustomTextChange = useCallback(
		(nextValue: string) => {
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
		},
		[activeQuestion]
	);

	const appendVoiceTranscript = useCallback(
		(transcript: string) => {
			if (activeQuestion?.kind === "text") {
				setTextValue((current) => appendVoiceText(current, transcript));
				return;
			}
			if (activeQuestion) {
				handleCustomTextChange(
					appendVoiceText(customTextRef.current, transcript)
				);
			}
		},
		[activeQuestion, handleCustomTextChange]
	);
	const {
		state: voiceState,
		error: voiceError,
		start: startVoice,
		stop: stopVoice,
	} = useVoiceRecorder({
		transcribe: voice?.transcribe ?? noopTranscribe,
		onTranscript: appendVoiceTranscript,
	});
	const isRecording = voiceState === "recording";
	const isTranscribing = voiceState === "transcribing";

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
		initialAnswer?.selectedIds,
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
		if (isNativeNumber(max) && total > max) {
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
					<span className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-medium text-muted-foreground text-sm">
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
									appearance="question-option"
									className="-mx-2"
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
										"inline-flex h-5 min-w-5 items-center justify-center rounded-sm border px-1 font-medium text-sm",
										selectedIds.includes(QUESTION_CUSTOM_ID)
											? "border-primary bg-primary text-primary-foreground"
											: "border-border bg-transparent text-muted-foreground"
									)}
								>
									{/* The custom row's badge follows the last option, so with no
								    options it is the first letter. */}
									{optionBadge(activeQuestion.options?.length ?? 0)}
								</span>
								<div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-background px-1">
									<input
										aria-label={activeQuestion.customLabel ?? "Other"}
										className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1 text-foreground text-sm outline-none"
										onChange={(event) =>
											handleCustomTextChange(event.target.value)
										}
										placeholder={
											activeQuestion.customPlaceholder ?? "Type your answer"
										}
										value={customText}
									/>
									{voice && (
										<VoiceInputButton
											className="shrink-0"
											disabled={voice.disabled}
											isRecording={isRecording}
											isTranscribing={isTranscribing}
											onStart={startVoice}
											onStop={stopVoice}
										/>
									)}
								</div>
							</div>
						)}
					</div>
				)}

			{activeQuestion.kind === "text" && (
				<div className="flex items-end gap-1 rounded-md border border-border bg-background px-1">
					<textarea
						aria-label="Your answer"
						className="min-w-0 flex-1 resize-y border-0 bg-transparent px-1 py-1.5 text-foreground text-sm outline-none"
						onChange={(event) => setTextValue(event.target.value)}
						placeholder={activeQuestion.placeholder ?? "Type your answer"}
						rows={3}
						value={textValue}
					/>
					{voice && (
						<VoiceInputButton
							className="mb-0.5 shrink-0"
							disabled={voice.disabled}
							isRecording={isRecording}
							isTranscribing={isTranscribing}
							onStart={startVoice}
							onStop={stopVoice}
						/>
					)}
				</div>
			)}
			{voice && voiceError && (
				<p aria-live="polite" className="text-status-destructive text-xs">
					{voiceError}
				</p>
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
								appearance="question-navigation"
								disabled={!canGoPrev}
								onClick={onPreviousQuestion}
								size="sm"
								type="button"
								variant="ghost-muted"
							>
								Previous
							</Button>
						)}
						{onNextQuestion && (
							<Button
								appearance="question-navigation"
								disabled={!canGoNext}
								onClick={onNextQuestion}
								size="sm"
								type="button"
								variant="ghost-muted"
							>
								Next
							</Button>
						)}
					</div>
				)}
				<div className="flex items-center justify-end gap-1.5">
					{allowSkip && (
						<Button
							appearance="question-navigation"
							onClick={handleSkip}
							size="sm"
							type="button"
							variant="ghost-muted"
						>
							{skipLabel}
						</Button>
					)}
					<Button
						appearance="question-submit"
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
