"use client";

// beui.dev/components/agents/approval-card

import {
	ArrowLeft02Icon,
	ArrowRight02Icon,
	BubbleChatIcon,
	Cancel01Icon,
	HelpCircleIcon,
	Loading03Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AgentDisclosure } from "@ryu/ui/components/agents/agent-disclosure.tsx";
import { ActionSwapRollText } from "@ryu/ui/components/motion/action-swap-roll.tsx";
import { Button } from "@ryu/ui/components/motion/button/index.tsx";
import { EASE_OUT } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	EMPTY_ANSWER,
	getStatusClass,
	getStatusLabel,
	getStatusLabelClass,
	isAnswered,
	ProgressDots,
	QuestionOptions,
} from "./parts.tsx";
import type {
	ApprovalCardAnswer,
	ApprovalCardAnswers,
	ApprovalCardProps,
} from "./types.ts";

export type {
	ApprovalCardAnswer,
	ApprovalCardAnswers,
	ApprovalCardOption,
	ApprovalCardProps,
	ApprovalCardQuestion,
	ApprovalCardStatus,
} from "./types.ts";

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
				"w-full overflow-hidden rounded-xl bg-muted p-4 text-sm",
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
						<HugeiconsIcon
							className={cn("size-4", !reduce && "animate-spin")}
							icon={Loading03Icon}
						/>
					) : interactive ? (
						questionMode ? (
							<HugeiconsIcon className="size-4" icon={HelpCircleIcon} />
						) : (
							<HugeiconsIcon className="size-4" icon={BubbleChatIcon} />
						)
					) : status === "rejected" ? (
						<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
					) : (
						<HugeiconsIcon className="size-4" icon={Tick02Icon} />
					)}
				</span>

				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-start gap-3">
						<h3 className="min-w-0 flex-1 font-medium text-foreground text-sm leading-5">
							<ActionSwapRollText value={titleKey}>
								{displayTitle}
							</ActionSwapRollText>
						</h3>
						{questionMode && interactive ? (
							<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
								{currentStep + 1}/{questions.length}
							</span>
						) : (
							<span
								className={cn(
									"shrink-0 text-xs leading-5 transition-colors",
									getStatusLabelClass(status)
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
								<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
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
									disabled={busy || currentStep === 0}
									onClick={() => setStep(currentStep - 1)}
									size="icon"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={ArrowLeft02Icon} />
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
									className="ml-auto"
									disabled={busy || !isAnswered(currentAnswer)}
									onClick={continueQuestion}
									size={currentStep === questions.length - 1 ? "sm" : "icon"}
								>
									{busy ? (
										<HugeiconsIcon
											className={cn("size-4", !reduce && "animate-spin")}
											icon={Loading03Icon}
										/>
									) : currentStep === questions.length - 1 ? (
										<>
											{submitLabel}
											<HugeiconsIcon
												className="size-3.5"
												icon={ArrowRight02Icon}
											/>
										</>
									) : (
										<HugeiconsIcon className="size-4" icon={ArrowRight02Icon} />
									)}
								</Button>
							</div>
						) : (
							<div className="mt-4 flex flex-wrap items-center gap-2">
								<Button disabled={busy} onClick={onApprove} size="sm">
									{approveLabel}
								</Button>
								{onRequestChanges ? (
									<Button
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
										className="text-muted-foreground hover:text-status-destructive dark:hover:text-status-destructive"
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
