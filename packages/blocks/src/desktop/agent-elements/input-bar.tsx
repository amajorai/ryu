"use client";

import { Button } from "@ryu/ui/components/button";
import { Wave } from "@ryu/ui/components/wave";
import { cn } from "@ryu/ui/lib/utils";
import type { ChatStatus } from "ai";
import { memo, useCallback, useEffect, useRef, useState } from "react";

/**
 * Bars in the full-width recording waveform that replaces the textarea while the
 * mic is live. High enough to read as a dense, ChatGPT-style waveform spanning
 * the whole input; the recorder keeps a longer amplitude history to feed these.
 */
const RECORDING_WAVE_BARS = 48;

interface InputConfig {
	attachmentButtonPosition: "left" | "right";
	attachmentPreviewStyle: "thumbnail" | "chip" | "hidden";
	inputBarPlaceholder: string;
}

const DEFAULT_INPUT_CONFIG: InputConfig = {
	inputBarPlaceholder: "Send a message...",
	attachmentButtonPosition: "left",
	attachmentPreviewStyle: "thumbnail",
};

/** Stable fallback so the voice hook can be called unconditionally. */
const noopTranscribe = async (): Promise<string> => "";

import {
	IconChevronDown,
	IconChevronUp,
	IconGhost2,
	IconMessageCircleQuestion,
	IconX,
} from "@tabler/icons-react";
import type { ContextUsage } from "./context-usage.tsx";
import { ComposerToolbar } from "./input/composer-toolbar.tsx";
import { FileAttachment } from "./input/file-attachment.tsx";
import { GoalBar, type GoalBarProps } from "./input/goal-bar.tsx";
import type {
	DoubleCheckControls,
	GhostControls,
	GoalControls,
	PluginComposerControlRow,
} from "./input/goal-plus-button.tsx";
import { useInputTyping } from "./input/input-typing.tsx";
import { type SuggestionItem, Suggestions } from "./input/suggestions.tsx";
import { NumberRoll } from "./number-roll.tsx";
import type {
	QuestionAnswer,
	QuestionConfig,
} from "./question/question-prompt.tsx";
import { QuestionPrompt } from "./question/question-prompt.tsx";
import { QueueBar, type QueueBarProps } from "./queue/queue-bar.tsx";
import { useVoiceRecorder } from "./useVoiceRecorder.ts";

export interface AttachedImage {
	filename: string;
	id: string;
	mimeType?: string;
	size?: number;
	url: string;
}

export interface AttachedFile {
	filename: string;
	id: string;
	size?: number;
}

export interface InputBarProps {
	attachedFiles?: AttachedFile[];
	attachedImages?: AttachedImage[];
	autoFocus?: boolean;
	changeSummary?: {
		files: number;
		insertions: number;
		deletions: number;
	};
	className?: string;

	/**
	 * Single-row "compact" composer: the "+" sits to the left of the textarea and
	 * the trailing controls (model selector via {@link rightActions}, mic, send)
	 * to its right — the whole bar on one line, textarea auto-growing upward past
	 * one row. Used on the chat page once a conversation has history; the default
	 * (false) is the roomy stacked layout (textarea above, controls row below).
	 */
	compact?: boolean;

	/**
	 * Node rendered inside the composer box, above the textarea (and above any
	 * attachment chips) — e.g. a pending quote preview. Shares the box's rounded
	 * `bg-muted` fill so it reads as part of the composer.
	 */
	composerHeader?: React.ReactNode;

	/**
	 * Context-window usage for the persistent composer meter (donut ring +
	 * used-percentage, left of the model selector). Derived by the host from the
	 * conversation's latest usage stats; omit to hide.
	 */
	contextMeter?: ContextUsage;
	disabled?: boolean;

	/**
	 * Double-check (`/double-check`) affordances for the composer "+" dropdown.
	 * When provided, the dropdown gains a "Double-check" toggle row and a verdict
	 * badge appears beside the "+" once a review has run.
	 */
	doubleCheckControls?: DoubleCheckControls;
	/**
	 * When true (default) clicking a staged image attachment opens a
	 * fullscreen lightbox preview. Set to false to render thumbnails as
	 * plain non-interactive previews.
	 */
	enableImagePreview?: boolean;

	/**
	 * Allow submitting while a run is streaming. When true, pressing Enter (or the
	 * queue button) calls `onSend` even mid-stream so the host can enqueue the
	 * message instead of dropping it. Defaults to false (legacy block behaviour).
	 */
	enableQueue?: boolean;

	/**
	 * Ghost (temporary/incognito) chat active. When true, the composer box gets a
	 * persistent violet ring so it's visually obvious the current thread isn't
	 * being saved — mirroring the temporary-chat cue in ChatGPT / Grok.
	 */
	ghost?: boolean;

	/**
	 * Temporary-chat toggle for the composer "+" dropdown. When provided, the
	 * dropdown gains a "Temporary chat" row that flips {@link ghost}. Separate from
	 * `ghost` (which only drives the violet ring) so the host can hide the toggle
	 * — e.g. once a thread has messages — while still showing the active-ghost ring.
	 */
	ghostControls?: GhostControls;

	/**
	 * The goal bar rendered above the composer while a goal is active or being
	 * drafted. Mirrors the info-bar treatment. Omit to hide.
	 */
	goalBar?: GoalBarProps;

	/**
	 * Goal (`/goal`) affordances for the composer "+" dropdown and the active-goal
	 * chip. When provided, the "+" opens a menu (Add photos & files | Pursue goal).
	 */
	goalControls?: GoalControls;

	infoBar?: {
		title?: string;
		description?: string;
		onClose?: () => void;
		position?: "top" | "bottom";
		/** Optional primary action rendered on the right (e.g. "Upgrade"). */
		action?: {
			label: string;
			onClick: () => void;
		};
		/** Optional compact actions rendered on the right, before `action`. */
		actions?: {
			label: string;
			onClick: () => void;
			variant?: "default" | "secondary" | "ghost";
		}[];
	};
	isDragOver?: boolean;

	/** Content rendered on the left of the toolbar, next to the attachment button. */
	leftActions?: React.ReactNode;

	// Attachment support
	onAttach?: () => void;
	onChange?: (value: string) => void;

	/**
	 * Image generation. When provided, an image button appears in the toolbar
	 * (beside the mic) that takes the composer text as the prompt, generates an
	 * image via Core's /api/images/generate, and clears the composer. The host
	 * surfaces the resulting image in the conversation. Mirrors `voice`: the
	 * draft text is owned by this component, so the host receives only the prompt.
	 */
	onGenerateImage?: (prompt: string) => void | Promise<void>;

	/**
	 * Video generation. When provided, a video button appears beside image gen.
	 * Mirrors {@link onGenerateImage}: takes the composer text as the prompt,
	 * generates via Core's /api/video/generate, and clears the composer. Needs a
	 * video model loaded in the sdcpp engine to produce anything.
	 */
	onGenerateVideo?: (prompt: string) => void | Promise<void>;
	onPaste?: (e: React.ClipboardEvent) => void;
	onRemoveFile?: (id: string) => void;
	onRemoveImage?: (id: string) => void;
	onSend: (message: {
		role: "user";
		content: string;
		followUpMode?: "opposite";
	}) => void;
	onStop: () => void;
	/** Optional host-level keyboard handling for the raw textarea. */
	onTextareaKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	placeholder?: string;

	/**
	 * Composer toggles contributed by enabled plugins (`composer_controls`). Each
	 * renders as a toggle row in the "+" dropdown's Assist section; flipping one
	 * sets its `flag` in the per-request `plugin_flags` map. Threaded straight to
	 * the toolbar's `GoalPlusButton`.
	 */
	pluginControls?: PluginComposerControlRow[];

	questionBar?: {
		id: string;
		questions: QuestionConfig[];
		questionIndex?: number;
		totalQuestions?: number;
		onPreviousQuestion?: () => void;
		onNextQuestion?: () => void;
		submitLabel?: string;
		skipLabel?: string;
		allowSkip?: boolean;
		onSubmit: (answer: QuestionAnswer) => void;
		onSkip?: () => void;
	};

	/**
	 * Message queue. When provided, queued messages are listed in a bar above the
	 * composer (rendered like the info/question bars). The host owns the queue
	 * state and dispatch (see `useMessageQueue`); this is purely presentational.
	 */
	queueBar?: QueueBarProps;
	/** Content rendered on the right of the toolbar, before the send button. */
	rightActions?: React.ReactNode;
	status: ChatStatus;
	suggestions?:
		| SuggestionItem[]
		| {
				items: SuggestionItem[];
				className?: string;
				itemClassName?: string;
		  };

	// Typing animation
	typingAnimation?: {
		text: string;
		duration: number;
		image?: string;
		isActive: boolean;
		onComplete: () => void;
	};

	// Controlled mode
	value?: string;

	/**
	 * Voice input. When provided, a microphone button appears in the toolbar that
	 * records from the user's default mic, shows a live waveform, and appends the
	 * transcription to the composer text. `transcribe` uploads the recorded WAV
	 * and resolves with the transcript (wired to Core's /api/voice/transcribe).
	 */
	voice?: {
		transcribe: (audio: Blob) => Promise<string>;
		disabled?: boolean;
	};

	/**
	 * Live voice-mode (realtime conversation) entry. When provided, the trailing
	 * button's empty state becomes the voice-mode waveform (opens the full-screen
	 * overlay) instead of the STT mic; STT dictation (`voice`) relocates to its own
	 * small toolbar button. `onStart` opens voice mode.
	 */
	voiceMode?: {
		onStart: () => void;
		disabled?: boolean;
	};

	/**
	 * Workspace strip rendered as a separate row BELOW the composer box
	 * (Codex/Cowork-style project ▸ branch ▸ worktree controls). Omit to hide.
	 * Distinct from `leftActions`, which sit in the controls row inside the box.
	 */
	workspaceBar?: React.ReactNode;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
export const InputBar = memo(function InputBar({
	onSend,
	status,
	onStop,
	placeholder,
	className,
	onAttach,
	attachedImages = [],
	attachedFiles = [],
	changeSummary,
	onRemoveImage,
	onRemoveFile,
	onPaste,
	isDragOver,
	enableImagePreview = true,
	value: controlledValue,
	onChange: controlledOnChange,
	contextMeter,
	disabled,
	compact,
	ghost,
	ghostControls,
	autoFocus,
	suggestions = [],
	typingAnimation,
	infoBar,
	questionBar,
	queueBar,
	enableQueue,
	leftActions,
	rightActions,
	voice,
	voiceMode,
	onGenerateImage,
	onGenerateVideo,
	goalControls,
	doubleCheckControls,
	pluginControls,
	goalBar,
	workspaceBar,
	composerHeader,
	onTextareaKeyDown,
}: InputBarProps) {
	const [internalInput, setInternalInput] = useState("");
	const [isInfoBarOpen, setIsInfoBarOpen] = useState(true);
	const [dismissedQuestionId, setDismissedQuestionId] = useState<string | null>(
		null
	);
	const [questionBarIndex, setQuestionBarIndex] = useState(1);
	const isControlled = controlledValue !== undefined;
	const input = isControlled ? controlledValue : internalInput;
	const setInput = useCallback(
		(v: string) => {
			if (isControlled) {
				controlledOnChange?.(v);
			} else {
				setInternalInput(v);
			}
		},
		[isControlled, controlledOnChange]
	);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const config = DEFAULT_INPUT_CONFIG;

	// Voice input: record from the default mic, show a live waveform, and append
	// the transcript to the composer. The hook is always called (Rules of Hooks);
	// its UI only renders when a `voice` prop is supplied.
	const appendTranscript = useCallback(
		(text: string) => {
			const base = input.trim();
			setInput(base ? `${base} ${text}` : text);
			requestAnimationFrame(() => textareaRef.current?.focus());
		},
		[input, setInput]
	);
	const {
		state: voiceState,
		levels: voiceLevels,
		error: voiceError,
		start: startVoice,
		stop: stopVoice,
	} = useVoiceRecorder({
		transcribe: voice?.transcribe ?? noopTranscribe,
		onTranscript: appendTranscript,
	});
	const isRecording = voiceState === "recording";
	const isTranscribing = voiceState === "transcribing";

	// Image generation: take the composer text as the prompt, hand it to the host
	// (which calls Core's /api/images/generate and surfaces the result), then clear
	// the composer. An in-flight flag disables the button while the engine works —
	// sd-server runs on CPU and can be slow, so the control must not look dead.
	const [isGenerating, setIsGenerating] = useState(false);
	const handleGenerateImage = useCallback(() => {
		const prompt = input.trim();
		if (!(prompt && onGenerateImage) || isGenerating) {
			return;
		}
		setIsGenerating(true);
		setInput("");
		Promise.resolve(onGenerateImage(prompt)).finally(() => {
			setIsGenerating(false);
		});
	}, [input, onGenerateImage, isGenerating, setInput]);

	// Video generation mirrors image generation. Separate in-flight flag so the
	// two buttons disable independently.
	const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
	const handleGenerateVideo = useCallback(() => {
		const prompt = input.trim();
		if (!(prompt && onGenerateVideo) || isGeneratingVideo) {
			return;
		}
		setIsGeneratingVideo(true);
		setInput("");
		Promise.resolve(onGenerateVideo(prompt)).finally(() => {
			setIsGeneratingVideo(false);
		});
	}, [input, onGenerateVideo, isGeneratingVideo, setInput]);

	const isStreaming = status === "streaming" || status === "submitted";
	const isTyping = typingAnimation?.isActive ?? false;

	const { displayedText, showImage } = useInputTyping(
		typingAnimation?.text ?? "",
		typingAnimation?.duration ?? 2000,
		isTyping,
		typingAnimation?.onComplete ?? (() => {})
	);

	const canQueueNow = Boolean(enableQueue) && isStreaming;
	const effectivePlaceholder =
		canQueueNow && !isTyping
			? "Queue a message…"
			: (placeholder ?? config.inputBarPlaceholder);

	const showAttach = Boolean(onAttach);
	const attachRight = config.attachmentButtonPosition === "right";

	// Auto-resize textarea
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			return;
		}
		el.style.height = "0";
		const nextHeight = Math.min(el.scrollHeight, 120);
		el.style.height = `${nextHeight}px`;
		el.style.overflowY = el.scrollHeight > 120 ? "auto" : "hidden";
		el.style.overflowX = "hidden";
		// Re-measure on every value change so the textarea grows/shrinks with its
		// content (one row by default, expanding up to the 120px cap). Without
		// `input` in the deps this only ran on mount and the box never resized.
	}, []);

	useEffect(() => {
		if (!autoFocus) {
			return;
		}
		textareaRef.current?.focus();
	}, [autoFocus]);

	const handleSubmit = useCallback(
		(followUpMode?: "opposite") => {
			const trimmed = input.trim();
			if (!trimmed) {
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
		[input, isStreaming, disabled, enableQueue, onSend, setInput, queueBar]
	);

	const handleInfoBarClose = useCallback(() => {
		setIsInfoBarOpen(false);
		infoBar?.onClose?.();
	}, [infoBar]);

	const infoBarPosition = infoBar?.position ?? "top";
	const shouldShowInfoBar = Boolean(
		infoBar && (infoBar.title || infoBar.description)
	);
	const infoBarData = infoBar ?? {};

	const infoBarNode = shouldShowInfoBar ? (
		<div
			className={cn(
				"flex h-[34px] items-center justify-between gap-3 px-3",
				"overflow-hidden transition-all duration-150 ease-out",
				isInfoBarOpen ? "max-h-[34px] opacity-100" : "max-h-0 opacity-0",
				infoBarPosition === "top" ? "rounded-t-2xl" : "rounded-b-2xl"
			)}
		>
			<div className="min-w-0 truncate text-foreground text-xs">
				{infoBarData.title && (
					<span className="font-medium">{infoBarData.title}</span>
				)}
				{infoBarData.description && (
					<span className="text-muted-foreground/80">
						{infoBarData.title
							? ` ${infoBarData.description}`
							: infoBarData.description}
					</span>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1">
				{infoBarData.actions?.map((action) => (
					<Button
						className="h-6 px-2 text-xs"
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
						className="h-6 px-2 text-xs"
						onClick={infoBarData.action.onClick}
						size="sm"
						type="button"
					>
						{infoBarData.action.label}
					</Button>
				)}
				{infoBarData.onClose && (
					<Button
						aria-label="Close"
						className="size-6 shrink-0 text-muted-foreground/70 hover:text-foreground"
						onClick={handleInfoBarClose}
						size="icon"
						type="button"
						variant="ghost"
					>
						<IconX className="h-3.5 w-3.5" strokeWidth={2} />
					</Button>
				)}
			</div>
		</div>
	) : null;

	// Action bar: the workspace strip (project ▸ branch ▸ worktree) rendered as a
	// full-width footer directly beneath the textarea, part of the outer card — a thin
	// muted row with rounded bottom corners, exactly like the info bar's bottom variant.
	const actionBarNode = workspaceBar ? (
		<div className="flex h-[34px] min-w-0 items-center gap-0.5 rounded-b-2xl px-2">
			{workspaceBar}
		</div>
	) : null;

	// Ghost (temporary) chat: a top info-bar strip signalling the thread isn't being
	// saved. Neutral styling (no bg/border of its own) so it shows the frame color
	// like the other bars — the ghost icon + copy carry the signal.
	const ghostBarNode = ghost ? (
		<div className="flex h-[34px] items-center gap-2 rounded-t-2xl px-3 text-[12px] text-muted-foreground">
			<IconGhost2 className="size-3.5 shrink-0" />
			<span className="font-medium text-foreground">Ghost chat</span>
			<span className="truncate">Messages in this chat won't be saved.</span>
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
	const hasQueue = (queueBar?.items.length ?? 0) > 0;
	const noTopInfoBar = !shouldShowInfoBar || infoBarPosition === "bottom";
	const queueBarNode = hasQueue ? (
		<QueueBar
			items={queueBar?.items}
			onClear={queueBar?.onClear}
			onEdit={queueBar?.onEdit}
			onRemove={queueBar?.onRemove}
			onSendAll={queueBar?.onSendAll}
			onSendNow={queueBar?.onSendNow}
			onTurnOffQueueing={queueBar?.onTurnOffQueueing}
			roundTop={noTopInfoBar}
		/>
	) : null;

	const questionBarNode =
		shouldShowQuestionBar && activeQuestion ? (
			<div
				className={cn(
					"mx-auto w-full max-w-[calc(100%-24px)] border-border border-x border-t",
					noTopInfoBar && !hasQueue ? "rounded-t-2xl" : null
				)}
			>
				<div className="flex h-7 items-center justify-between border-border border-b px-3 text-muted-foreground text-xs">
					<div className="inline-flex items-center gap-1.5">
						<IconMessageCircleQuestion className="h-3.5 w-3.5" />
						Question
					</div>
					{showQuestionNavigation && (
						<div className="inline-flex items-center gap-1">
							<Button
								aria-label="Previous question"
								className="size-5 rounded-sm"
								disabled={!canGoPrev}
								onClick={handleQuestionPrevious}
								size="icon"
								type="button"
								variant="ghost"
							>
								<IconChevronUp className="h-3.5 w-3.5" />
							</Button>
							<span>
								{clampedQuestionIndex} of {totalQuestions}
							</span>
							<Button
								aria-label="Next question"
								className="size-5 rounded-sm"
								disabled={!canGoNext}
								onClick={handleQuestionNext}
								size="icon"
								type="button"
								variant="ghost"
							>
								<IconChevronDown className="h-3.5 w-3.5" />
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
						setDismissedQuestionId(questionBarData?.id);
					}}
					questionIndex={clampedQuestionIndex}
					questions={questionSet}
					skipLabel={questionBarData?.skipLabel}
					submitLabel={questionBarData?.submitLabel}
					totalQuestions={totalQuestions}
				/>
			</div>
		) : null;

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			onTextareaKeyDown?.(e);
			if (e.defaultPrevented) {
				return;
			}
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSubmit(e.ctrlKey || e.metaKey ? "opposite" : undefined);
			}
		},
		[handleSubmit, onTextareaKeyDown]
	);

	const hasInput = input.trim().length > 0;
	const hasContextItems = attachedImages.length > 0 || attachedFiles.length > 0;
	const showContextItems =
		hasContextItems && config.attachmentPreviewStyle !== "hidden";
	const imageDisplayMode =
		config.attachmentPreviewStyle === "thumbnail" ? "image-only" : "chip";
	const showChangeSummary = Boolean(
		changeSummary &&
			(changeSummary.files > 0 ||
				changeSummary.insertions > 0 ||
				changeSummary.deletions > 0)
	);

	const handleContainerClick = useCallback((e: React.MouseEvent) => {
		if (
			e.target === e.currentTarget ||
			!(e.target as HTMLElement).closest("button, textarea")
		) {
			textareaRef.current?.focus();
		}
	}, []);

	const handleSuggestionSelect = useCallback(
		(item: SuggestionItem) => {
			if (disabled || isStreaming) {
				return;
			}
			setInput(item.value ?? item.label);
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (!el) {
					return;
				}
				el.focus();
				const end = el.value.length;
				el.setSelectionRange(end, end);
			});
		},
		[disabled, isStreaming, setInput]
	);

	const suggestionItems = Array.isArray(suggestions)
		? suggestions
		: (suggestions?.items ?? []);
	const suggestionsClassName = Array.isArray(suggestions)
		? undefined
		: suggestions?.className;
	const suggestionItemClassName = Array.isArray(suggestions)
		? undefined
		: suggestions?.itemClassName;

	// The textarea (or its typing-animation stand-in). Shared by both layouts:
	// the stacked default wraps it in its own padded block above the controls
	// row; compact mode threads it through the toolbar as the flexing centre so
	// the "+" and trailing controls flank it on a single line.
	//
	// While recording, the textarea is REPLACED (not overlaid) by a full-width
	// live waveform that fills the input slot — like ChatGPT. Swapping it out (vs
	// covering it) means text input is inherently disallowed (there is no textarea
	// to type into), the focus ring stays untouched, and the stop control in the
	// toolbar below/beside stays reachable. Any text already typed lives in `input`
	// state (not the DOM), so it reappears intact when recording stops.
	let inputContent: React.ReactNode;
	if (isTyping) {
		inputContent = (
			<div className="w-full text-[14px] text-muted-foreground leading-[1.6]">
				<span>{displayedText}</span>
				<span className="ml-px inline-block h-[1em] w-[2px] animate-an-blink bg-foreground align-text-bottom" />
			</div>
		);
	} else if (isRecording) {
		inputContent = (
			<Wave
				aria-label="Recording"
				barCount={RECORDING_WAVE_BARS}
				className="h-6 w-full text-primary"
				levels={voiceLevels}
			/>
		);
	} else {
		inputContent = (
			<>
				<textarea
					className={cn(
						"peer w-full resize-none border-0 bg-transparent text-[14px] text-foreground leading-[1.6] outline-none placeholder:text-muted-foreground",
						"overflow-hidden",
						disabled && "cursor-not-allowed opacity-50"
					)}
					disabled={disabled}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					onPaste={onPaste}
					placeholder={effectivePlaceholder}
					ref={textareaRef}
					rows={1}
					value={input}
				/>
				<div className="pointer-events-none absolute inset-0 z-20 rounded-2xl opacity-0 outline-2 outline-ring transition-opacity duration-75 ease-in-out peer-focus:opacity-100 peer-focus-visible:opacity-100" />
			</>
		);
	}

	// The controls row (the "+", model selector, voice/image, send). In compact
	// mode it also hosts the textarea as its flexing centre.
	const composerToolbar = (
		<ComposerToolbar
			attachRight={attachRight}
			canQueue={canQueueNow && hasInput}
			center={
				compact ? (
					// Match the 28px (h-7) control buttons so a single-row composer reads
					// vertically centered: `min-h-7` floors the column to button height and
					// `items-center` centers the textarea within it. As the textarea grows
					// past one row the column outgrows 28px and the toolbar's `items-end`
					// pins the "+"/send to the bottom (ChatGPT/Claude-style).
					<div className="flex min-h-7 min-w-0 flex-1 items-center">
						{inputContent}
					</div>
				) : undefined
			}
			compact={compact}
			contextMeter={contextMeter}
			disabled={disabled}
			doubleCheckControls={doubleCheckControls}
			ghostControls={ghostControls}
			goalControls={goalControls}
			hasImageGen={Boolean(onGenerateImage)}
			hasInput={hasInput}
			hasVideoGen={Boolean(onGenerateVideo)}
			hasVoice={Boolean(voice)}
			isGeneratingImage={isGenerating}
			isGeneratingVideo={isGeneratingVideo}
			isRecording={isRecording}
			isStreaming={isStreaming}
			isTranscribing={isTranscribing}
			leftActions={leftActions}
			onAttach={onAttach}
			onGenerateImage={handleGenerateImage}
			onGenerateVideo={handleGenerateVideo}
			onStartVoice={startVoice}
			onStop={onStop}
			onStopVoice={stopVoice}
			onSubmit={handleSubmit}
			pluginControls={pluginControls}
			rightActions={rightActions}
			showAttach={showAttach}
			voiceDisabled={voice?.disabled}
			voiceMode={voiceMode}
		/>
	);

	return (
		<div className={cn("shrink-0 px-3 pb-3", className)}>
			<div className="mx-auto max-w-[720px]">
				{showChangeSummary && changeSummary ? (
					<div
						aria-live="polite"
						className="mb-2 flex justify-center text-[13px]"
					>
						<div className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/70 bg-popover/95 px-3 text-muted-foreground shadow-sm backdrop-blur">
							<span>
								<NumberRoll value={changeSummary.files} /> file
								{changeSummary.files === 1 ? "" : "s"} changed
							</span>
							<span className="font-medium text-emerald-600 dark:text-emerald-400">
								+<NumberRoll trend="up" value={changeSummary.insertions} />
							</span>
							<span className="font-medium text-red-600 dark:text-red-400">
								-<NumberRoll trend="down" value={changeSummary.deletions} />
							</span>
						</div>
					</div>
				) : null}
				<div
					className={cn(
						"flex flex-col gap-0",
						// Reference architecture: the outer wrapper is the FRAME color
						// (distinct from the input box), so the bars — which carry no bg of
						// their own — show this color, and the sliver at the input box's
						// rounded corners is the same color as the bars (seamless).
						shouldShowInfoBar || goalBar || workspaceBar
							? "rounded-2xl bg-card"
							: null
					)}
				>
					{goalBar && <GoalBar {...goalBar} />}
					{ghostBarNode}
					{infoBarPosition === "top" && infoBarNode}
					{queueBarNode}
					{questionBarNode}
					{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: custom drag/resize interaction */}
					<div
						className={cn(
							// No border/ring: the box is distinguished from the darker
							// `bg-card` frame (and its bars) purely by its lighter `bg-muted`
							// fill, so there is no ring on the textarea and no sliver.
							"relative cursor-text rounded-2xl bg-muted",
							// A drag-over ring always wins for the duration of the drag so
							// the drop target stays legible.
							isDragOver && "ring-2 ring-primary ring-inset"
						)}
						onClick={handleContainerClick}
					>
						{/* Composer header (e.g. pending quote preview), above the chips. */}
						{composerHeader}
						{/* Context items (attached images/files) */}
						<div
							className={cn(
								"grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out",
								showContextItems && "grid-rows-[1fr]"
							)}
						>
							<div className="overflow-hidden">
								{showContextItems && (
									<div className="flex flex-wrap items-center gap-[6px] px-2.5 pt-2.5 pb-0.5">
										{attachedImages.map((img) => (
											<FileAttachment
												display={imageDisplayMode}
												enableImagePreview={enableImagePreview}
												filename={img.filename}
												id={img.id}
												isImage
												key={img.id}
												onRemove={
													onRemoveImage
														? () => onRemoveImage(img.id)
														: undefined
												}
												size={img.size}
												url={img.url}
											/>
										))}
										{attachedFiles.map((file) => (
											<FileAttachment
												filename={file.filename}
												id={file.id}
												key={file.id}
												onRemove={
													onRemoveFile ? () => onRemoveFile(file.id) : undefined
												}
												size={file.size}
											/>
										))}
									</div>
								)}
							</div>
						</div>

						{/* Typing animation image */}
						{isTyping && typingAnimation?.image && showImage && (
							<div className="flex flex-wrap gap-2 px-3 pt-3">
								<div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md">
									{/* biome-ignore lint/performance/noImgElement lint/correctness/useImageSize: dynamic remote logo URL */}
									<img
										alt=""
										className="h-full w-full object-cover"
										src={typingAnimation.image}
									/>
								</div>
							</div>
						)}

						{compact ? (
							// Compact single-row layout: the toolbar hosts the textarea as
							// its flexing centre, so "+" · input · model/mic/send sit on one
							// line. Always rendered (the send button lives here).
							composerToolbar
						) : (
							<>
								{/* Text input or typing animation text */}
								<div className="min-h-[56px] pt-3 pr-3 pb-1 pl-3.5">
									{inputContent}
								</div>

								{/* Controls row, INSIDE the composer box (Codex-style): the
								    "+", model selector, voice/image, and send button all share
								    the textarea's rounded card and background. */}
								{(leftActions ||
									rightActions ||
									showAttach ||
									voice ||
									voiceMode ||
									onGenerateImage ||
									onGenerateVideo ||
									goalControls ||
									ghostControls ||
									pluginControls?.length ||
									contextMeter) &&
									composerToolbar}
							</>
						)}
					</div>

					{voice && voiceError && (
						<p className="px-3 pt-1 text-destructive text-xs">{voiceError}</p>
					)}
					{suggestionItems.length > 0 && (
						<Suggestions
							className={cn("mt-4 px-3", suggestionsClassName)}
							disabled={disabled || isStreaming}
							itemClassName={suggestionItemClassName}
							items={suggestionItems}
							onSelect={handleSuggestionSelect}
						/>
					)}
					{infoBarPosition === "bottom" && infoBarNode}
					{/* Action bar (project ▸ branch ▸ worktree): full-width footer inside
					    the card, directly beneath the input — same slot as the bottom
					    info bar. */}
					{actionBarNode}
				</div>
			</div>
		</div>
	);
});
