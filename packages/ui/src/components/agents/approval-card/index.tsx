"use client";

// beui.dev/components/agents/approval-card

import { AgentDisclosure } from "@ryu/ui/components/agents/agent-disclosure.tsx";
import { ActionSwapRollText } from "@ryu/ui/components/motion/action-swap-roll.tsx";
import { Button } from "@ryu/ui/components/motion/button/index.tsx";
import { Checkbox } from "@ryu/ui/components/motion/checkbox.tsx";
import { Input } from "@ryu/ui/components/motion/input.tsx";
import {
	RadioGroup,
	RadioGroupItem,
} from "@ryu/ui/components/motion/radio.tsx";
import { EASE_OUT, SPRING_SWAP } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	ArrowLeft,
	ArrowRight,
	Check,
	CircleHelp,
	LoaderCircle,
	MessageSquareText,
	X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ApprovalCardAnswer,
	ApprovalCardAnswers,
	ApprovalCardProps,
	ApprovalCardQuestion,
	ApprovalCardStatus,
} from "./types.ts";

export type {
	ApprovalCardAnswer,
	ApprovalCardAnswers,
	ApprovalCardOption,
	ApprovalCardProps,
	ApprovalCardQuestion,
	ApprovalCardStatus,
} from "./types.ts";

const EMPTY_ANSWER: ApprovalCardAnswer = { selected: [], custom: "" };

function getStatusLabel(status: ApprovalCardStatus) {
	if (status === "submitting") {
		return "Submitting";
	}
	if (status === "approved") {
		return "Approved";
	}
	if (status === "rejected") {
		return "Rejected";
	}
	if (status === "changes-requested") {
		return "Changes requested";
	}
	if (status === "answered") {
		return "Response submitted";
	}
	return "Input required";
}

function getStatusClass(status: ApprovalCardStatus) {
	if (status === "approved" || status === "answered") {
		return "text-status-success";
	}
	if (status === "rejected") {
		return "text-status-destructive";
	}
	if (status === "changes-requested") {
		return "text-status-warning";
	}
	return "text-muted-foreground";
}

function getStatusBadgeClass(status: ApprovalCardStatus) {
	if (status === "pending" || status === "changes-requested") {
		return "border-warning/30 bg-warning/10 text-status-warning";
	}
	if (status === "submitting") {
		return "border-info/30 bg-info/10 text-status-info";
	}
	if (status === "approved" || status === "answered") {
		return "border-success/30 bg-success/10 text-status-success";
	}
	return "border-destructive/30 bg-destructive/10 text-status-destructive";
}

function isAnswered(answer: ApprovalCardAnswer) {
	return answer.selected.length > 0 || Boolean(answer.custom?.trim());
}

function QuestionOptions({
	question,
	answer,
	disabled,
	onChange,
	onSingleSelect,
}: {
	question: ApprovalCardQuestion;
	answer: ApprovalCardAnswer;
	disabled: boolean;
	onChange: (answer: ApprovalCardAnswer) => void;
	onSingleSelect?: () => void;
}) {
	const custom = answer.custom ?? "";

	return (
		<div className="mt-3">
			{question.options?.length ? (
				question.multiple ? (
					<div className="grid gap-0.5">
						{question.options.map((option) => (
							<Checkbox
								checked={answer.selected.includes(option.value)}
								className="min-h-9 rounded-lg px-1.5 py-1"
								disabled={disabled || option.disabled}
								key={option.value}
								label={option.label}
								onCheckedChange={(checked) =>
									onChange({
										...answer,
										selected: checked
											? [...answer.selected, option.value]
											: answer.selected.filter(
													(value) => value !== option.value
												),
									})
								}
							/>
						))}
					</div>
				) : (
					<RadioGroup
						className="gap-0.5"
						onValueChange={(value) => {
							onChange({ selected: [value], custom: "" });
							onSingleSelect?.();
						}}
						value={answer.selected[0] ?? ""}
					>
						{question.options.map((option) => (
							<RadioGroupItem
								className="min-h-9 rounded-lg px-1.5 py-1"
								disabled={disabled || option.disabled}
								key={option.value}
								label={option.label}
								value={option.value}
							/>
						))}
					</RadioGroup>
				)
			) : null}

			{question.allowCustom ? (
				<Input
					className={cn("p-0.5", question.options?.length && "mt-1.5")}
					classNames={{
						field:
							"h-10 rounded-xl border-0 bg-background/70 focus-within:bg-background",
						input: "px-3 text-sm",
					}}
					disabled={disabled}
					onChange={(value) =>
						onChange({
							selected: question.multiple ? answer.selected : [],
							custom: value,
						})
					}
					placeholder={question.customPlaceholder ?? "Add another response…"}
					value={custom}
				/>
			) : null}
		</div>
	);
}

function ProgressDots({ current, ids }: { current: number; ids: string[] }) {
	return (
		<span className="flex gap-1.5">
			<span className="sr-only">
				Question {current + 1} of {ids.length}
			</span>
			{ids.map((id, index) => (
				<motion.span
					animate={{
						scale: index === current ? 1 : 0.75,
						opacity: index <= current ? 1 : 0.35,
					}}
					aria-hidden="true"
					className="size-1.5 rounded-full bg-foreground"
					initial={{
						scale: index === current ? 1 : 0.75,
						opacity: index <= current ? 1 : 0.35,
					}}
					key={id}
					transition={SPRING_SWAP}
				/>
			))}
		</span>
	);
}

export function ApprovalCard({
	title = "Approval required",
	description,
	children,
	questions = [],
	status = "pending",
	answers,
	defaultAnswers = {},
	onAnswersChange,
	step,
	defaultStep = 0,
	onStepChange,
	onSubmit,
	onApprove,
	onReject,
	onRequestChanges,
	onDismiss,
	approveLabel = "Approve",
	submitLabel = "Submit response",
	result,
	className,
	appearance = "default",
}: ApprovalCardProps) {
	const reduce = useReducedMotion() ?? false;
	const [internalAnswers, setInternalAnswers] =
		useState<ApprovalCardAnswers>(defaultAnswers);
	const [internalStep, setInternalStep] = useState(defaultStep);
	const autoAdvanceTimer = useRef<number | undefined>(undefined);
	const currentAnswers = answers ?? internalAnswers;
	const currentStep = Math.min(
		Math.max(0, step ?? internalStep),
		Math.max(0, questions.length - 1)
	);
	const question = questions[currentStep];
	const questionMode = questions.length > 0;
	const pending = status === "pending";
	const busy = status === "submitting";
	const interactive = pending || busy;
	const currentAnswer = question
		? (currentAnswers[question.id] ?? EMPTY_ANSWER)
		: EMPTY_ANSWER;
	const displayTitle = question?.title ?? title;
	const titleKey = question?.id ?? String(status);
	const statusLabel = getStatusLabel(status);

	const clearAutoAdvance = useCallback(() => {
		if (autoAdvanceTimer.current === undefined) {
			return;
		}
		window.clearTimeout(autoAdvanceTimer.current);
		autoAdvanceTimer.current = undefined;
	}, []);

	useEffect(() => clearAutoAdvance, [clearAutoAdvance]);

	const setAnswers = useCallback(
		(next: ApprovalCardAnswers) => {
			if (answers === undefined) {
				setInternalAnswers(next);
			}
			onAnswersChange?.(next);
		},
		[answers, onAnswersChange]
	);

	const setStep = (next: number) => {
		clearAutoAdvance();
		if (step === undefined) {
			setInternalStep(next);
		}
		onStepChange?.(next);
	};

	const updateCurrentAnswer = (next: ApprovalCardAnswer) => {
		if (!question) {
			return;
		}
		setAnswers({ ...currentAnswers, [question.id]: next });
	};

	const continueQuestion = () => {
		if (currentStep < questions.length - 1) {
			setStep(currentStep + 1);
			return;
		}
		onSubmit?.(currentAnswers);
	};

	const queueAutoAdvance = () => {
		if (
			!question ||
			question.multiple ||
			question.autoAdvance === false ||
			currentStep >= questions.length - 1 ||
			busy
		) {
			return;
		}

		clearAutoAdvance();
		autoAdvanceTimer.current = window.setTimeout(() => {
			setStep(currentStep + 1);
		}, 240);
	};

	return (
		<div
			aria-busy={busy}
			className={cn(
				"w-full overflow-hidden rounded-2xl bg-muted p-4 text-sm",
				appearance === "docs" && "bg-docs-preview-background",
				className
			)}
			data-state={status}
		>
			<div className="flex items-start gap-3">
				<span
					aria-hidden="true"
					className={cn(
						"grid size-5 shrink-0 place-items-center text-muted-foreground",
						getStatusClass(status)
					)}
				>
					{busy ? (
						<LoaderCircle className={cn("size-4", !reduce && "animate-spin")} />
					) : interactive ? (
						questionMode ? (
							<CircleHelp className="size-4" />
						) : (
							<MessageSquareText className="size-4" />
						)
					) : status === "rejected" ? (
						<X className="size-4" />
					) : (
						<Check className="size-4" />
					)}
				</span>

				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-start gap-3">
						<h3 className="min-w-0 flex-1 font-medium text-base text-foreground leading-5">
							<ActionSwapRollText value={titleKey}>
								{displayTitle}
							</ActionSwapRollText>
						</h3>
						{questionMode && interactive ? (
							<span className="shrink-0 text-muted-foreground/65 text-xs tabular-nums">
								{currentStep + 1}/{questions.length}
							</span>
						) : (
							<span
								className={cn(
									"type-caption shrink-0 rounded-full border px-2 py-0.5 font-medium transition-colors",
									getStatusBadgeClass(status)
								)}
							>
								{statusLabel}
							</span>
						)}
						{onDismiss ? (
							<button
								aria-label="Dismiss"
								className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								onClick={onDismiss}
								type="button"
							>
								<X className="size-4" />
							</button>
						) : null}
					</div>

					<AgentDisclosure open={interactive}>
						{questionMode && question ? (
							<AnimatePresence initial={false} mode="wait">
								<motion.div
									animate={{ opacity: 1, x: 0 }}
									exit={reduce ? { opacity: 0 } : { opacity: 0, x: -6 }}
									initial={reduce ? { opacity: 1 } : { opacity: 0, x: 8 }}
									key={question.id}
									transition={{ duration: reduce ? 0 : 0.2, ease: EASE_OUT }}
								>
									{question.description ? (
										<p className="mt-1 text-muted-foreground leading-5">
											{question.description}
										</p>
									) : null}
									<QuestionOptions
										answer={currentAnswer}
										disabled={busy}
										onChange={updateCurrentAnswer}
										onSingleSelect={queueAutoAdvance}
										question={question}
									/>
								</motion.div>
							</AnimatePresence>
						) : (
							<div>
								{description ? (
									<p className="mt-1 text-muted-foreground leading-5">
										{description}
									</p>
								) : null}
								{children ? <div className="mt-3">{children}</div> : null}
							</div>
						)}

						{questionMode ? (
							<div className="mt-4 flex items-center gap-3">
								<Button
									aria-label="Previous question"
									className="rounded-full"
									disabled={busy || currentStep === 0}
									onClick={() => setStep(currentStep - 1)}
									size="icon"
									variant="ghost"
								>
									<ArrowLeft className="size-4" />
								</Button>
								<ProgressDots
									current={currentStep}
									ids={questions.map((item) => item.id)}
								/>
								<Button
									aria-label={
										currentStep === questions.length - 1
											? "Submit response"
											: "Next question"
									}
									className="ml-auto rounded-full"
									disabled={busy || !isAnswered(currentAnswer)}
									onClick={continueQuestion}
									size={currentStep === questions.length - 1 ? "sm" : "icon"}
								>
									{busy ? (
										<LoaderCircle
											className={cn("size-4", !reduce && "animate-spin")}
										/>
									) : currentStep === questions.length - 1 ? (
										<>
											{submitLabel}
											<ArrowRight className="size-3.5" />
										</>
									) : (
										<ArrowRight className="size-4" />
									)}
								</Button>
							</div>
						) : (
							<div className="mt-4 flex flex-wrap items-center gap-2">
								<Button
									className="rounded-full"
									disabled={busy}
									onClick={onApprove}
									size="sm"
								>
									{approveLabel}
								</Button>
								{onRequestChanges ? (
									<Button
										className="rounded-full"
										disabled={busy}
										onClick={onRequestChanges}
										size="sm"
										variant="secondary"
									>
										Request changes
									</Button>
								) : null}
								{onReject ? (
									<Button
										className="rounded-full text-muted-foreground hover:text-status-destructive dark:hover:text-status-destructive"
										disabled={busy}
										onClick={onReject}
										size="sm"
										variant="ghost"
									>
										Reject
									</Button>
								) : null}
							</div>
						)}
					</AgentDisclosure>

					{interactive ? null : (
						<p className="mt-1 text-muted-foreground text-sm">
							{result ?? statusLabel}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
