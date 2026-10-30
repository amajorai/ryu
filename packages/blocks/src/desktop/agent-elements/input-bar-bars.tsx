import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	Bookmark01Icon,
	Cancel01Icon,
	GhostIcon,
	MessageQuestionIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback } from "react";
import styles from "./input-bar.module.css";
import type { useComposerAutoGrow } from "./input-bar-auto-grow.ts";
import type { InputBarBaseScope } from "./input-bar-scope.ts";
import type { useInputBarState } from "./input-bar-state.tsx";
import { QuestionPrompt } from "./question/question-prompt.tsx";
import { QueueBar } from "./queue/queue-bar.tsx";

export type UseInputBarBarsInput = InputBarBaseScope &
	ReturnType<typeof useInputBarState> &
	ReturnType<typeof useComposerAutoGrow>;

/** Submit, and the info, action, ghost, queue and question bars above the composer. */
export function useInputBarBars({
	input,
	hasInput,
	isStreaming,
	setInput,
	queueBar,
	disabled,
	enableQueue,
	onSend,
	setIsInfoBarOpen,
	voiceError,
	clearVoiceError,
	infoBar,
	effectiveInfoBar,
	seamless,
	goalBar,
	workspaceBar,
	ghost,
	isInfoBarOpen,
	temporaryChatSaveControls,
	dismissedQuestionId,
	questionBar,
	questionBarIndex,
	setQuestionBarIndex,
	setDismissedQuestionId,
	voice,
	composerPrompt,
}: UseInputBarBarsInput) {
	const handleSubmit = useCallback(
		(followUpMode?: "opposite") => {
			const trimmed = input.trim();
			if (!hasInput) {
				// Empty composer: Enter sends the first queued message now (same as the
				// queue row's "send now" affordance).
				const first = queueBar?.items[0];
				if (first && queueBar?.onSendNow && !disabled) {
					queueBar.onSendNow(first.id);
				}
				return;
			}
			// When queueing is enabled, allow submit mid-stream so the host can enqueue
			// the message rather than drop it. Otherwise keep the legacy block.
			if (disabled || (isStreaming && !enableQueue)) {
				return;
			}
			onSend({ role: "user", content: trimmed, followUpMode });
			setInput("");
		},
		[
			disabled,
			enableQueue,
			hasInput,
			input,
			isStreaming,
			onSend,
			queueBar,
			setInput,
		]
	);

	const handleInfoBarClose = useCallback(() => {
		setIsInfoBarOpen(false);
		if (voiceError) {
			clearVoiceError();
		} else {
			infoBar?.onClose?.();
		}
	}, [voiceError, clearVoiceError, infoBar]);

	const infoBarPosition = effectiveInfoBar?.position ?? "top";
	const infoBarVariant = effectiveInfoBar?.variant ?? "default";
	const isDestructiveInfoBar = infoBarVariant === "destructive";
	const shouldShowInfoBar = Boolean(
		effectiveInfoBar && (effectiveInfoBar.title || effectiveInfoBar.description)
	);
	const infoBarData = effectiveInfoBar ?? {};
	const hasComposerFrameBars =
		!seamless && (shouldShowInfoBar || goalBar || workspaceBar || ghost);

	const infoBarNode = shouldShowInfoBar ? (
		<div
			aria-live={isDestructiveInfoBar ? undefined : "polite"}
			className={cn(
				styles.infoBar,
				isInfoBarOpen ? styles.infoBarOpen : styles.infoBarClosed,
				infoBarPosition === "top" ? "rounded-t-2xl" : "rounded-b-2xl"
			)}
			data-position={infoBarPosition}
			data-slot="composer-info-bar"
			role={isDestructiveInfoBar ? "alert" : undefined}
		>
			<div
				className={cn(
					"min-w-0 flex-1 truncate text-xs",
					isDestructiveInfoBar ? "text-status-destructive" : "text-foreground"
				)}
			>
				{infoBarData.title && (
					<span className="font-medium">{infoBarData.title}</span>
				)}
				{infoBarData.description && (
					<span
						className={
							isDestructiveInfoBar
								? "text-status-destructive/80"
								: "text-muted-foreground"
						}
					>
						{infoBarData.title
							? ` ${infoBarData.description}`
							: infoBarData.description}
					</span>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1">
				{infoBarData.actions?.map((action) => (
					<Button
						appearance="composer-info-action"
						key={action.label}
						onClick={action.onClick}
						size="sm"
						type="button"
						variant={action.variant ?? "secondary"}
					>
						{action.label}
					</Button>
				))}
				{infoBarData.action && (
					<Button
						appearance="composer-info-action"
						onClick={infoBarData.action.onClick}
						size="sm"
						type="button"
					>
						{infoBarData.action.label}
					</Button>
				)}
				{infoBarData.onClose && (
					<Button
						appearance={
							isDestructiveInfoBar
								? "composer-info-dismiss-destructive"
								: "composer-info-dismiss"
						}
						aria-label="Close"
						className="size-6 shrink-0"
						onClick={handleInfoBarClose}
						size="icon"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="h-3.5 w-3.5"
							icon={Cancel01Icon}
							strokeWidth={2}
						/>
					</Button>
				)}
			</div>
		</div>
	) : null;

	// Action bar: the workspace strip (project ▸ branch ▸ worktree) rendered as a
	// full-width footer directly beneath the textarea, part of the outer card — a thin
	// muted row with rounded bottom corners, exactly like the info bar's bottom variant.
	//
	// It carries its OWN fill. The comment above has always described a "muted row",
	// but the element had neither, so it inherited the composer card's background
	// and read as part of the textarea rather than as a strip under it — most
	// obviously in compact mode, where the textarea block is short enough that the
	// two became one undifferentiated box.
	const actionBarNode = workspaceBar ? (
		<div
			className={cn(
				"flex h-[34px] min-w-0 items-center gap-0.5 px-2",
				seamless ? "bg-transparent" : "rounded-b-2xl"
			)}
		>
			{workspaceBar}
		</div>
	) : null;

	// Temporary chat: a top info-bar strip signalling the thread isn't being
	// saved. Neutral styling (no bg/border of its own) so it shows the frame color
	// like the other bars — the ghost icon + copy carry the signal.
	const ghostBarNode = ghost ? (
		<div className="flex h-[34px] min-w-0 items-center gap-2 rounded-t-2xl px-3 text-muted-foreground text-xs">
			<HugeiconsIcon className="size-3.5 shrink-0" icon={GhostIcon} />
			<span className="shrink-0 font-medium text-foreground">
				Temporary chat
			</span>
			<span className="min-w-0 flex-1 truncate">
				Messages in this chat won't be saved.
			</span>
			{temporaryChatSaveControls ? (
				<Button
					appearance="composer-save-temporary"
					aria-label={
						temporaryChatSaveControls.saving
							? "Saving temporary chat"
							: "Save temporary chat"
					}
					disabled={
						temporaryChatSaveControls.disabled ||
						temporaryChatSaveControls.saving
					}
					onClick={temporaryChatSaveControls.onSave}
					title="Save this temporary chat to your history"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3.5" icon={Bookmark01Icon} />
					{temporaryChatSaveControls.saving ? "Saving…" : "Save chat"}
				</Button>
			) : null}
		</div>
	) : null;

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

	// Queue bar sits between a top info bar and the question bar. It only rounds
	// its top corners when nothing (info bar) is stacked above it.
	const noTopInfoBar = !shouldShowInfoBar || infoBarPosition === "bottom";
	// Narrow on `queueBar` itself rather than re-reading it optionally per prop:
	// the old form forwarded six `queueBar?.x` values, every one of them
	// `T | undefined`, into props QueueBarProps declares as required. Spreading
	// the narrowed object also keeps the two in step as QueueBarProps grows.
	const queueBarNode =
		queueBar && queueBar.items.length > 0 ? (
			<QueueBar {...queueBar} roundTop={noTopInfoBar} />
		) : null;
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
	const activeComposerPrompt = composerPrompt
		? composerPrompt
		: questionBarNode
			? {
					id: `question:${questionBarData?.id ?? "pending"}`,
					content: questionBarNode,
				}
			: undefined;
	return {
		handleSubmit,
		infoBarPosition,
		hasComposerFrameBars,
		infoBarNode,
		actionBarNode,
		ghostBarNode,
		queueBarNode,
		activeComposerPrompt,
	} as const;
}
