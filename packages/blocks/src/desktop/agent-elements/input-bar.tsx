"use client";

import { PatchDiff } from "@pierre/diffs/react";
import { Button } from "@ryu/ui/components/button";
import { ComposerEditor } from "@ryu/ui/components/editor/composer-editor.tsx";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { Wave } from "@ryu/ui/components/wave";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { ChatStatus } from "ai";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

/**
 * Bars in the full-width recording waveform that replaces the textarea while the
 * mic is live. High enough to read as a dense, ChatGPT-style waveform spanning
 * the whole input; the recorder keeps a longer amplitude history to feed these.
 */
const RECORDING_WAVE_BARS = 48;

/**
 * Measure the textarea at the compact row's stable width. Measuring a detached
 * clone avoids a layout feedback loop: once the real editor moves into the wider
 * full layout, its own `scrollHeight` can fall back to one line and otherwise
 * make the composer bounce between layouts.
 */
function textareaWrapsAtWidth(
	textarea: HTMLTextAreaElement,
	value: string,
	width: number
): boolean {
	if (!(value && width > 0)) {
		return false;
	}
	const probe = textarea.cloneNode(false);
	if (!(probe instanceof HTMLTextAreaElement)) {
		return value.includes("\n");
	}
	probe.removeAttribute("id");
	probe.removeAttribute("name");
	probe.setAttribute("aria-hidden", "true");
	probe.tabIndex = -1;
	probe.style.position = "fixed";
	probe.style.top = "0";
	probe.style.left = "-10000px";
	probe.style.width = `${width}px`;
	probe.style.height = "0";
	probe.style.minHeight = "0";
	probe.style.maxHeight = "none";
	probe.style.overflow = "hidden";
	probe.style.pointerEvents = "none";
	probe.style.visibility = "hidden";
	probe.value = "";
	document.body.append(probe);
	try {
		const singleLineHeight = probe.scrollHeight;
		probe.value = value;
		return probe.scrollHeight > singleLineHeight + 1;
	} finally {
		probe.remove();
	}
}

interface InputConfig {
	attachmentPreviewStyle: "thumbnail" | "chip" | "hidden";
	inputBarPlaceholder: string;
}

const DEFAULT_INPUT_CONFIG: InputConfig = {
	inputBarPlaceholder: "What do you want to do?",
	attachmentPreviewStyle: "thumbnail",
};

/** Stable fallback so the voice hook can be called unconditionally. */
const noopTranscribe = async (): Promise<string> => "";

import {
	IconBookmark,
	IconChevronDown,
	IconChevronUp,
	IconCircle,
	IconCircleCheck,
	IconGhost2,
	IconLoader2,
	IconMessageCircleQuestion,
	IconWorld,
	IconX,
} from "@tabler/icons-react";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import { resolveComposerKeyAction } from "./composer-send-shortcut.ts";
import type { ContextUsage } from "./context-usage.tsx";
import { FileTypeIcon } from "./file-type-icon.tsx";
import { hasComposerInput } from "./input/composer-input.ts";
import type {
	ComposerMenuGroup,
	ComposerMenuItem,
} from "./input/composer-menu.tsx";
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
import { findMentionAt } from "./mention-format.ts";
import { MentionToken } from "./mention-token.tsx";
import type {
	QuestionAnswer,
	QuestionConfig,
} from "./question/question-prompt.tsx";
import { QuestionPrompt } from "./question/question-prompt.tsx";
import { QueueBar, type QueueBarProps } from "./queue/queue-bar.tsx";
import type { MentionItem } from "./types.ts";
import { useVoiceRecorder } from "./useVoiceRecorder.ts";

const useSafeLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface AttachedImage {
	filename: string;
	id: string;
	mimeType?: string;
	size?: number;
	url: string;
}

export interface ComposerDraftItem {
	id: string;
	preview: string;
	text: string;
}
export interface ComposerDraftControls {
	items: ComposerDraftItem[];
	onDelete: (id: string) => void;
	onInsert: (text: string) => void;
	onSave: (text: string) => void;
}

/** Explicit promotion action for a temporary chat that is currently in memory. */
export interface TemporaryChatSaveControls {
	disabled?: boolean;
	onSave: () => void;
	saving?: boolean;
}

export interface AttachedFile {
	filename: string;
	id: string;
	size?: number;
}

/**
 * Composer info-bar strip (top or bottom of the outer card). Use
 * `variant: "destructive"` for errors — `bg-destructive/10` so they sit above
 * the input instead of crowding the workspace / sources footer.
 */
export interface InputBarInfoBar {
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
	description?: string;
	onClose?: () => void;
	position?: "top" | "bottom";
	title?: string;
	/** Visual tone. `"destructive"` uses a soft red wash for composer errors. */
	variant?: "default" | "destructive";
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
	 * Responsive compact composer used once a conversation has history. A plain
	 * one-line textarea shares the row with the controls; as soon as it explicitly
	 * or visually wraps, the textarea moves above the normal full controls row.
	 * Rich Markdown and manually expanded composers always use the full layout.
	 */
	compact?: boolean;

	/**
	 * Node rendered inside the composer box, above the textarea (and above any
	 * attachment chips) — e.g. a pending quote preview. Shares the box's rounded
	 * `bg-muted` fill so it reads as part of the composer.
	 */
	composerHeader?: React.ReactNode;
	/** Searchable apps/plugins/context rows shown by the shared + menu. */
	composerMenuGroups?: ComposerMenuGroup[];
	/**
	 * An active approval or other human-input card that temporarily replaces the
	 * textarea. It lives in the same layout surface as the normal composer so the
	 * surface can animate between writing and deciding without a second floating
	 * card.
	 */
	composerPrompt?: {
		content: React.ReactNode;
		id: string;
	};

	/**
	 * Context-window usage for the persistent composer meter (donut ring +
	 * used-percentage, left of the model selector). Derived by the host from the
	 * conversation's latest usage stats; omit to hide.
	 */
	contextMeter?: ContextUsage;
	/** Open the full context breakdown when the meter is clicked. Omit to keep
	 *  the meter a read-only ring. */
	contextMeterOnOpen?: () => void;
	disabled?: boolean;

	/**
	 * Double-check (`/double-check`) affordances for the composer "+" dropdown.
	 * When provided, the dropdown gains a "Double-check" toggle row and a verdict
	 * badge appears beside the "+" once a review has run.
	 */
	doubleCheckControls?: DoubleCheckControls;
	draftControls?: ComposerDraftControls;
	/**
	 * When true (default) clicking a staged image attachment opens a
	 * fullscreen lightbox preview. Set to false to render thumbnails as
	 * plain non-interactive previews.
	 */
	enableImagePreview?: boolean;

	/**
	 * Allow submitting while a run is streaming. When true, pressing Enter (or the
	 * primary send button) calls `onSend` even mid-stream so the host can enqueue the
	 * message instead of dropping it. Defaults to false (legacy block behaviour).
	 */
	enableQueue?: boolean;
	/** Render the plugin-owned control that expands the composer in place. */
	expandComposer?: boolean;

	/**
	 * Temporary (incognito) chat active. When true, the composer box gets a
	 * persistent violet ring so it's visually obvious the current thread isn't
	 * being saved — mirroring the temporary-chat cue in ChatGPT / Grok.
	 */
	ghost?: boolean;

	/**
	 * Temporary-chat toggle for the composer "+" dropdown. When provided, the
	 * dropdown gains a "Temporary chat" row that flips {@link ghost}. Separate from
	 * `ghost` (which only drives the violet ring) so the host can hide the toggle
	 * — e.g. once a thread has messages — while still showing the temporary ring.
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

	infoBar?: InputBarInfoBar;
	isDragOver?: boolean;

	/** Content rendered on the left of the toolbar, next to the attachment button. */
	leftActions?: React.ReactNode;
	/** Resolved @ mentions used to paint the live composer preview. */
	mentionItems?: MentionItem[];

	// Attachment support
	onAttach?: () => void;
	onChange?: (value: string) => void;
	onComposerMenuSelect?: (item: ComposerMenuItem) => void;

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
	/** Report the total composer height to a compact host surface. */
	onHeightChange?: (height: number) => void;
	onPaste?: (e: React.ClipboardEvent) => void;
	onRemoveFile?: (id: string) => void;
	onRemoveImage?: (id: string) => void;
	onSend: (message: {
		role: "user";
		content: string;
		followUpMode?: "opposite";
	}) => void;
	onStop: () => void;
	/** Optional host-level keyboard handling for the composer editor. */
	onTextareaKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
	placeholder?: string;
	/** Ghost prompt and keyboard-navigable prompt list supplied by a host/plugin. */
	placeholderSuggestion?: string;

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
	/** Remove the composer field's card chrome when embedded in voice mode. */
	seamless?: boolean;
	status: ChatStatus;
	suggestions?:
		| SuggestionItem[]
		| {
				items: SuggestionItem[];
				className?: string;
				itemClassName?: string;
		  };
	/** Save the client-held temporary transcript as a normal conversation. */
	temporaryChatSaveControls?: TemporaryChatSaveControls;
	/** Live todo list and file edits derived from the current user turn. */
	turnProgress?: InputBarTurnProgress;

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

export interface InputBarTurnProgress {
	deletions: number;
	files: {
		deletions: number;
		insertions: number;
		preview?: string;
		path: string;
	}[];
	insertions: number;
	todos?: {
		current: number;
		items: {
			label: string;
			status: "completed" | "in_progress" | "pending";
		}[];
		total: number;
	};
}

function TurnProgressFile({
	file,
}: {
	file: InputBarTurnProgress["files"][number];
}) {
	const row = (
		<button
			className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-muted"
			type="button"
		>
			<FileTypeIcon className="size-4 shrink-0" path={file.path} />
			<span className="min-w-0 flex-1 truncate">{file.path}</span>
			<span className="text-emerald-600 tabular-nums dark:text-emerald-400">
				+{formatNumber(file.insertions)}
			</span>
			<span className="text-red-600 tabular-nums dark:text-red-400">
				−{formatNumber(file.deletions)}
			</span>
		</button>
	);
	if (!file.preview) {
		return row;
	}
	return (
		<HoverCard>
			<HoverCardTrigger closeDelay={120} delay={160} render={row} />
			<HoverCardContent
				align="start"
				className="w-[min(42rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border-border/70 bg-popover/95 p-2 shadow-xl backdrop-blur-xl"
				side="top"
				sideOffset={8}
			>
				<div className="mb-1 px-2 py-1 font-mono text-muted-foreground text-xs">
					{file.path}
				</div>
				<div className="max-h-[28rem] overflow-auto rounded-xl border border-border/60 bg-background/60">
					<PatchDiff
						disableWorkerPool
						options={{
							diffStyle: "unified",
							lineHoverHighlight: "line",
						}}
						patch={file.preview}
					/>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
export const InputBar = memo(function InputBar({
	onSend,
	status,
	onStop,
	placeholder,
	placeholderSuggestion,
	className,
	onAttach,
	attachedImages = [],
	attachedFiles = [],
	changeSummary,
	turnProgress,
	onRemoveImage,
	onRemoveFile,
	onPaste,
	isDragOver,
	enableImagePreview = true,
	value: controlledValue,
	onChange: controlledOnChange,
	contextMeter,
	contextMeterOnOpen,
	disabled,
	composerPrompt,
	expandComposer,
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
	draftControls,
	seamless,
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
	composerMenuGroups,
	mentionItems,
	onComposerMenuSelect,
	onHeightChange,
	onTextareaKeyDown,
	temporaryChatSaveControls,
}: InputBarProps) {
	const [internalInput, setInternalInput] = useState("");
	const [isInfoBarOpen, setIsInfoBarOpen] = useState(true);
	const [dismissedQuestionId, setDismissedQuestionId] = useState<string | null>(
		null
	);
	const [questionBarIndex, setQuestionBarIndex] = useState(1);
	const [suggestionIndex, setSuggestionIndex] = useState(-1);
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
	const richEditorRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const compactTextareaWidthRef = useRef<number | null>(null);
	const [isCompactTextareaMultiline, setIsCompactTextareaMultiline] =
		useState(false);
	const [plusMenuQueryStart, setPlusMenuQueryStart] = useState<number | null>(
		null
	);
	const config = DEFAULT_INPUT_CONFIG;
	const [isExpanded, setIsExpanded] = useState(false);
	const { animationsEnabled, composerSendShortcut, markdownComposer } =
		useChatDisplayPrefs();
	const isCompactSingleRow = Boolean(
		compact && !isCompactTextareaMultiline && !isExpanded && !markdownComposer
	);
	const focusComposer = useCallback(() => {
		if (markdownComposer) {
			richEditorRef.current?.focus();
			return;
		}
		textareaRef.current?.focus();
	}, [markdownComposer]);
	const reduceMotion = !animationsEnabled || (useReducedMotion() ?? false);
	const composerTransition = reduceMotion
		? { duration: 0 }
		: {
				damping: 34,
				mass: 0.75,
				stiffness: 420,
				type: "spring" as const,
			};

	useEffect(() => {
		if (!onHeightChange) {
			return;
		}
		const element = containerRef.current;
		if (!element) {
			return;
		}
		const report = () => onHeightChange(element.offsetHeight);
		report();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(report);
		observer.observe(element);
		return () => observer.disconnect();
	}, [onHeightChange]);

	const openExpandedComposer = useCallback(() => {
		setIsExpanded(true);
	}, []);

	useEffect(() => {
		if (!expandComposer) {
			setIsExpanded(false);
		}
	}, [expandComposer]);

	useEffect(() => {
		if (!isExpanded) {
			return;
		}
		const frame = requestAnimationFrame(focusComposer);
		return () => cancelAnimationFrame(frame);
	}, [focusComposer, isExpanded]);

	// Voice input: record from the default mic, show a live waveform, and append
	// the transcript to the composer. The hook is always called (Rules of Hooks);
	// its UI only renders when a `voice` prop is supplied.
	const appendTranscript = useCallback(
		(text: string) => {
			const base = input.trim();
			setInput(base ? `${base} ${text}` : text);
			requestAnimationFrame(focusComposer);
		},
		[focusComposer, input, setInput]
	);
	const {
		state: voiceState,
		levels: voiceLevels,
		error: voiceError,
		clearError: clearVoiceError,
		start: startVoice,
		stop: stopVoice,
	} = useVoiceRecorder({
		transcribe: voice?.transcribe ?? noopTranscribe,
		onTranscript: appendTranscript,
	});
	const isRecording = voiceState === "recording";
	const isTranscribing = voiceState === "transcribing";

	// Voice / mic failures surface on the top info-bar (destructive) so they
	// don't crowd the workspace / sources footer under the input.
	const effectiveInfoBar: InputBarInfoBar | undefined = voiceError
		? {
				description: voiceError,
				variant: "destructive",
				position: "top",
				onClose: clearVoiceError,
			}
		: infoBar;

	// Re-open the strip whenever its content changes (new error, new banner).
	useEffect(() => {
		if (
			effectiveInfoBar &&
			(effectiveInfoBar.title || effectiveInfoBar.description)
		) {
			setIsInfoBarOpen(true);
		}
	}, [
		effectiveInfoBar?.title,
		effectiveInfoBar?.description,
		effectiveInfoBar?.variant,
	]);

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
			? "Send a message…"
			: (placeholder ?? config.inputBarPlaceholder);

	const showAttach = Boolean(onAttach);

	// Auto-resize textarea
	useSafeLayoutEffect(() => {
		if (markdownComposer) {
			setIsCompactTextareaMultiline(false);
			return;
		}
		const el = textareaRef.current;
		if (!el) {
			return;
		}
		const maxHeight = isExpanded ? 360 : 120;
		const minHeight = isExpanded ? 280 : 0;
		el.style.height = "0";
		const nextHeight = Math.min(
			Math.max(el.scrollHeight, minHeight),
			maxHeight
		);
		el.style.height = `${nextHeight}px`;
		el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
		el.style.overflowX = "hidden";

		if (!compact) {
			setIsCompactTextareaMultiline(false);
			return;
		}
		const renderedWidth = el.getBoundingClientRect().width;
		if (isCompactSingleRow && renderedWidth > 0) {
			compactTextareaWidthRef.current = renderedWidth;
		}
		const compactWidth = compactTextareaWidthRef.current;
		if (compactWidth && compactWidth > 0) {
			const nextMultiline = textareaWrapsAtWidth(el, input, compactWidth);
			setIsCompactTextareaMultiline((current) =>
				current === nextMultiline ? current : nextMultiline
			);
		}
		// Re-measure on every value change so the textarea grows/shrinks with its
		// content (one row by default, expanding up to the 120px cap, or the
		// roomier expanded cap). Without
		// `input` in the deps this only ran on mount and the box never resized.
		// A repo-wide lint/format sweep (9fed37659) emptied this array once already
		// and the composer went back to a permanently one-line box — `input` is
		// load-bearing, not a lint artefact.
	}, [compact, input, isCompactSingleRow, isExpanded, markdownComposer]);

	useEffect(() => {
		if (!autoFocus) {
			return;
		}
		focusComposer();
	}, [autoFocus, focusComposer]);

	const hasContextItems = attachedImages.length > 0 || attachedFiles.length > 0;
	const hasInput = hasComposerInput(
		input,
		attachedImages.length + attachedFiles.length
	);

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

	const infoBarNode = shouldShowInfoBar ? (
		<div
			className={cn(
				"mx-3 flex h-[34px] items-center justify-between gap-3 px-3",
				"overflow-hidden transition-[max-height,opacity] duration-150 ease-out",
				isInfoBarOpen ? "max-h-[34px] opacity-100" : "max-h-0 opacity-0",
				infoBarPosition === "top" ? "rounded-t-2xl" : "rounded-b-2xl",
				isDestructiveInfoBar && "bg-destructive/10"
			)}
			role={isDestructiveInfoBar ? "alert" : undefined}
		>
			<div
				className={cn(
					"min-w-0 truncate text-xs",
					isDestructiveInfoBar ? "text-destructive" : "text-foreground"
				)}
			>
				{infoBarData.title && (
					<span className="font-medium">{infoBarData.title}</span>
				)}
				{infoBarData.description && (
					<span
						className={
							isDestructiveInfoBar
								? "text-destructive/80"
								: "text-muted-foreground/80"
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
						className={cn(
							"size-6 shrink-0",
							isDestructiveInfoBar
								? "text-destructive/70 hover:text-destructive"
								: "text-muted-foreground/70 hover:text-foreground"
						)}
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
				seamless ? "bg-transparent" : "rounded-b-2xl bg-muted/40"
			)}
		>
			{workspaceBar}
		</div>
	) : null;

	// Temporary chat: a top info-bar strip signalling the thread isn't being
	// saved. Neutral styling (no bg/border of its own) so it shows the frame color
	// like the other bars — the ghost icon + copy carry the signal.
	const ghostBarNode = ghost ? (
		<div className="flex h-[34px] min-w-0 items-center gap-2 rounded-t-2xl px-3 text-[12px] text-muted-foreground">
			<IconGhost2 className="size-3.5 shrink-0" />
			<span className="shrink-0 font-medium text-foreground">
				Temporary chat
			</span>
			<span className="min-w-0 flex-1 truncate">
				Messages in this chat won't be saved.
			</span>
			{temporaryChatSaveControls ? (
				<Button
					aria-label={
						temporaryChatSaveControls.saving
							? "Saving temporary chat"
							: "Save temporary chat"
					}
					className="h-7 shrink-0 gap-1.5 px-2 text-xs"
					disabled={
						temporaryChatSaveControls.disabled ||
						temporaryChatSaveControls.saving
					}
					onClick={temporaryChatSaveControls.onSave}
					title="Save this temporary chat to your history"
					type="button"
					variant="ghost"
				>
					<IconBookmark className="size-3.5" />
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
				className="w-full overflow-hidden rounded-[1.25rem] border border-border/70 bg-background/80"
				data-composer-prompt="question"
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

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLElement>) => {
			onTextareaKeyDown?.(e);
			if (e.defaultPrevented) {
				return;
			}
			if (markdownComposer) {
				const target = e.target;
				const richEditor = richEditorRef.current;
				if (!(target instanceof Node && richEditor?.contains(target))) {
					return;
				}
			}
			if (e.key === "Escape" && isExpanded) {
				e.preventDefault();
				setIsExpanded(false);
				return;
			}
			const promptItems = Array.isArray(suggestions)
				? suggestions
				: (suggestions?.items ?? []);
			if (
				!(input.trim() || isStreaming) &&
				e.key === "Tab" &&
				placeholderSuggestion
			) {
				e.preventDefault();
				setInput(placeholderSuggestion);
				return;
			}
			if (
				!(input.trim() || isStreaming) &&
				(e.key === "ArrowDown" || e.key === "ArrowUp")
			) {
				e.preventDefault();
				setSuggestionIndex((current) =>
					Math.max(
						-1,
						Math.min(
							promptItems.length - 1,
							current + (e.key === "ArrowDown" ? 1 : -1)
						)
					)
				);
				return;
			}
			if (
				!(input.trim() || isStreaming) &&
				e.key === "Enter" &&
				suggestionIndex >= 0
			) {
				e.preventDefault();
				const item = promptItems[suggestionIndex];
				if (item) {
					setInput(item.value ?? item.label);
				}
				setSuggestionIndex(-1);
				return;
			}
			const action = resolveComposerKeyAction(composerSendShortcut, {
				ctrlKey: e.ctrlKey,
				key: e.key,
				metaKey: e.metaKey,
				shiftKey: e.shiftKey,
			});
			if (action.kind === "send") {
				e.preventDefault();
				handleSubmit(action.followUpMode);
			}
		},
		[
			composerSendShortcut,
			handleSubmit,
			input,
			isExpanded,
			isStreaming,
			markdownComposer,
			onTextareaKeyDown,
			setInput,
			suggestionIndex,
			suggestions,
		]
	);

	const composerSuggestions = Array.isArray(suggestions)
		? suggestions
		: (suggestions?.items ?? []);
	const showComposerSuggestions =
		composerSuggestions.length > 0 && !hasInput && !isStreaming;
	const showContextItems =
		hasContextItems && config.attachmentPreviewStyle !== "hidden";
	const imageDisplayMode =
		config.attachmentPreviewStyle === "thumbnail" ? "image-only" : "chip";
	const effectiveChangeSummary = turnProgress
		? {
				files: turnProgress.files.length,
				insertions: turnProgress.insertions,
				deletions: turnProgress.deletions,
			}
		: changeSummary;
	const showChangeSummary = Boolean(
		effectiveChangeSummary &&
			(effectiveChangeSummary.files > 0 ||
				effectiveChangeSummary.insertions > 0 ||
				effectiveChangeSummary.deletions > 0)
	);
	const showTurnProgress = showChangeSummary || Boolean(turnProgress?.todos);

	const handleContainerClick = useCallback(
		(e: React.MouseEvent) => {
			const target = e.target as HTMLElement;
			// Portaled menus/popovers (agent picker search, etc.) still bubble through
			// the React tree into this container. Skip any interactive control so a
			// click on the picker's search field cannot yank focus back to the prompt.
			if (
				target !== e.currentTarget &&
				target.closest(
					"button, textarea, input, select, a, [role='menuitem'], [contenteditable='true']"
				)
			) {
				return;
			}
			focusComposer();
		},
		[focusComposer]
	);

	const handleSuggestionSelect = useCallback(
		(item: SuggestionItem) => {
			if (disabled || isStreaming) {
				return;
			}
			setInput(item.value ?? item.label);
			requestAnimationFrame(() => {
				if (markdownComposer) {
					focusComposer();
					return;
				}
				const el = textareaRef.current;
				if (!el) {
					return;
				}
				el.focus();
				const end = el.value.length;
				el.setSelectionRange(end, end);
			});
		},
		[disabled, focusComposer, isStreaming, markdownComposer, setInput]
	);
	const renderComposerPreview = useCallback((): ReactNode[] => {
		const parts: ReactNode[] = [];
		let cursor = 0;
		for (let index = 0; index < input.length; index += 1) {
			const mention = findMentionAt(input, index, mentionItems);
			const isUrl =
				(index === 0 || /\s/.test(input[index - 1] ?? "")) &&
				/^https?:\/\//i.test(input.slice(index));
			if (!(mention || isUrl)) {
				continue;
			}
			const end = mention
				? mention.end
				: (() => {
						let urlEnd = index;
						while (urlEnd < input.length && !/\s|</.test(input[urlEnd] ?? "")) {
							urlEnd += 1;
						}
						return urlEnd;
					})();
			parts.push(input.slice(cursor, index));
			const token = input.slice(index, end);
			parts.push(
				mention?.item ? (
					<MentionToken item={mention.item} key={`${index}-${token}`}>
						{mention.item.label}
					</MentionToken>
				) : (
					<span className="font-medium text-primary" key={`${index}-${token}`}>
						<IconWorld
							aria-hidden="true"
							className="mr-1 inline-flex size-3.5 align-[-2px]"
						/>
						{token}
					</span>
				)
			);
			cursor = end;
			index = end - 1;
		}
		if (cursor < input.length) {
			parts.push(input.slice(cursor));
		}
		return parts;
	}, [input, mentionItems]);

	const suggestionItems = Array.isArray(suggestions)
		? suggestions
		: (suggestions?.items ?? []);
	const suggestionsClassName = Array.isArray(suggestions)
		? undefined
		: suggestions?.className;
	const suggestionItemClassName = Array.isArray(suggestions)
		? undefined
		: suggestions?.itemClassName;
	const handleRichChange = useCallback(
		(next: string) => {
			setSuggestionIndex(-1);
			setInput(next);
		},
		[setInput]
	);
	const renderRichMention = useCallback(
		(label: string, item?: MentionItem) => (
			<MentionToken item={item}>{label}</MentionToken>
		),
		[]
	);

	// The textarea (or its typing-animation stand-in). A one-line compact textarea
	// is threaded through the toolbar as its flexible centre. Once it wraps, the
	// same node moves into the full padded block above the controls row.
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
	} else if (markdownComposer) {
		inputContent = (
			<div onKeyDownCapture={handleKeyDown}>
				<ComposerEditor
					disabled={disabled}
					editorRef={richEditorRef}
					markdown={input}
					mentionItems={mentionItems}
					mentionRenderer={renderRichMention}
					onChange={handleRichChange}
					onPaste={onPaste}
					placeholder={effectivePlaceholder}
				/>
			</div>
		);
	} else {
		inputContent = (
			<div className="relative w-full">
				{showComposerSuggestions &&
					placeholderSuggestion &&
					suggestionIndex < 0 && (
						<div className="pointer-events-none absolute inset-x-0 top-0 z-10 truncate text-[14px] text-muted-foreground/60 leading-[1.6]">
							{placeholderSuggestion}
							<span className="ml-2 rounded border px-1 text-[10px]">Tab</span>
						</div>
					)}
				{showComposerSuggestions && suggestionIndex >= 0 && (
					<div className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border bg-popover p-1 shadow-lg">
						{composerSuggestions.map((item, index) => (
							<button
								className={cn(
									"block w-full rounded px-2 py-1.5 text-left text-sm",
									index === suggestionIndex && "bg-accent"
								)}
								key={item.id}
								onClick={() => handleSuggestionSelect(item)}
								type="button"
							>
								{item.label}
							</button>
						))}
					</div>
				)}
				{input && (
					<div
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words text-[14px] text-foreground leading-[1.6]"
					>
						{renderComposerPreview()}
					</div>
				)}
				<textarea
					className={cn(
						"relative w-full resize-none border-0 bg-transparent text-transparent leading-[1.6] caret-foreground outline-none placeholder:text-muted-foreground",
						"overflow-hidden",
						disabled && "cursor-not-allowed opacity-50"
					)}
					disabled={disabled}
					onChange={(e) => {
						setSuggestionIndex(-1);
						setInput(e.target.value);
					}}
					onKeyDown={handleKeyDown}
					onPaste={onPaste}
					placeholder={effectivePlaceholder}
					ref={textareaRef}
					rows={1}
					value={input}
				/>
			</div>
		);
	}

	// The controls are inline around a single-line compact textarea, then return to
	// the standard row below as soon as that textarea wraps.
	const composerToolbar = (
		<ComposerToolbar
			center={
				isCompactSingleRow ? (
					<div className="flex min-h-8 min-w-0 flex-1 items-center">
						{inputContent}
					</div>
				) : undefined
			}
			compact={isCompactSingleRow}
			contextMeter={contextMeter}
			contextMeterOnOpen={contextMeterOnOpen}
			directoryGroups={composerMenuGroups}
			directoryQuery={
				plusMenuQueryStart === null ? "" : input.slice(plusMenuQueryStart)
			}
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
			onDirectorySelect={(item) => {
				const start = plusMenuQueryStart ?? input.length;
				const prefix = input.slice(0, start).trimEnd();
				setInput(`${prefix}${prefix ? " " : ""}@${item.label} `);
				setPlusMenuQueryStart(null);
				onComposerMenuSelect?.(item);
			}}
			onExpand={
				expandComposer && !isExpanded ? openExpandedComposer : undefined
			}
			onGenerateImage={handleGenerateImage}
			onGenerateVideo={handleGenerateVideo}
			onMenuOpenChange={(open) => {
				setPlusMenuQueryStart(open ? input.length : null);
				if (open) {
					requestAnimationFrame(focusComposer);
				}
			}}
			onStartVoice={startVoice}
			onStop={onStop}
			onStopVoice={stopVoice}
			onSubmit={handleSubmit}
			pluginControls={pluginControls}
			rightActions={
				<>
					{draftControls && (
						<Popover>
							<PopoverTrigger
								render={
									<Button
										aria-label="Drafts"
										className="size-8"
										size="icon"
										variant="ghost"
									>
										<IconBookmark className="size-4" />
									</Button>
								}
							/>
							<PopoverContent align="end" className="w-80 p-2">
								<div className="mb-1 px-2 py-1 font-medium text-sm">Drafts</div>
								{draftControls.items.length === 0 ? (
									<div className="px-2 py-3 text-muted-foreground text-sm">
										No drafts for this project
									</div>
								) : (
									draftControls.items.map((item) => (
										<div
											className="group flex items-center gap-1 rounded-md px-2 py-1 hover:bg-muted"
											key={item.id}
										>
											<button
												className="min-w-0 flex-1 truncate text-left text-sm"
												onClick={() => draftControls.onInsert(item.text)}
												type="button"
											>
												{item.preview}
											</button>
											<Button
												aria-label={`Delete ${item.preview}`}
												className="size-7 opacity-0 group-hover:opacity-100"
												onClick={() => draftControls.onDelete(item.id)}
												size="icon"
												variant="ghost"
											>
												<IconX className="size-3.5" />
											</Button>
										</div>
									))
								)}
							</PopoverContent>
						</Popover>
					)}
					{draftControls && (
						<Button
							aria-label="Save draft"
							className="size-8"
							disabled={!hasInput}
							onClick={() => {
								draftControls.onSave(input);
								setInput("");
							}}
							size="icon"
							variant="ghost"
						>
							<IconBookmark className="size-4" />
						</Button>
					)}
					{rightActions}
				</>
			}
			showAttach={showAttach}
			voiceDisabled={voice?.disabled}
			voiceMode={voiceMode}
		/>
	);

	const renderComposerSuggestions = (expanded: boolean) =>
		suggestionItems.length > 0 && !activeComposerPrompt ? (
			<Suggestions
				className={cn(
					expanded ? "mt-2 px-1" : "mt-4 px-3",
					suggestionsClassName
				)}
				disabled={disabled || isStreaming}
				itemClassName={suggestionItemClassName}
				items={suggestionItems}
				onSelect={handleSuggestionSelect}
			/>
		) : null;

	const renderComposerSurface = (expanded: boolean) => (
		<motion.div
			className={cn(
				"composer-container relative cursor-text",
				seamless
					? "bg-transparent"
					: "rounded-2xl border border-border/60 bg-muted/90 shadow-sm",
				expanded && !seamless && "border-border/80 shadow-md",
				isDragOver && "ring-2 ring-primary ring-inset",
				ghost && "ring-1 ring-violet-500/70"
			)}
			initial={false}
			onClick={handleContainerClick}
			transition={composerTransition}
		>
			{expanded && (
				<Button
					aria-label="Collapse composer"
					className="absolute top-2.5 right-2.5 z-10 size-7 text-muted-foreground hover:text-foreground"
					onClick={(event) => {
						event.stopPropagation();
						setIsExpanded(false);
					}}
					size="icon"
					title="Collapse composer"
					type="button"
					variant="ghost"
				>
					<IconX className="size-4" />
				</Button>
			)}
			<AnimatePresence initial={false} mode="wait">
				{activeComposerPrompt ? (
					<motion.div
						animate={{ opacity: 1, scale: 1, y: 0 }}
						className="w-full"
						exit={{ opacity: 0, scale: 0.985, y: -6 }}
						initial={reduceMotion ? false : { opacity: 0, scale: 0.985, y: 8 }}
						key={`composer-prompt-${activeComposerPrompt.id}`}
						transition={{ duration: reduceMotion ? 0 : 0.2 }}
					>
						{activeComposerPrompt.content}
					</motion.div>
				) : (
					<motion.div
						animate={{ opacity: 1, scale: 1, y: 0 }}
						className="w-full"
						exit={{ opacity: 0, scale: 0.985, y: 6 }}
						initial={reduceMotion ? false : { opacity: 0, scale: 0.985, y: -8 }}
						key="composer-input"
						transition={{ duration: reduceMotion ? 0 : 0.2 }}
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
									<div
										className="flex flex-wrap items-center gap-[6px] px-2.5 pt-2.5 pb-0.5"
										data-slot="composer-attachments"
									>
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

						{isCompactSingleRow ? (
							composerToolbar
						) : (
							<>
								{/* Full layout: textarea above, every control below. Compact
								    drafts arrive here automatically once they wrap. */}
								<div
									className={
										expanded
											? "min-h-[320px] pt-4 pr-14 pb-3 pl-5"
											: "flex min-h-[64px] flex-col justify-center py-2.5 pr-3 pl-3.5"
									}
								>
									{inputContent}
								</div>

								{/* Controls row, INSIDE the composer box (Codex-style): the
								    "+", agent selector, voice/image, and send button all share
								    the textarea's rounded card and background. */}
								{(compact ||
									leftActions ||
									rightActions ||
									showAttach ||
									voice ||
									voiceMode ||
									onGenerateImage ||
									onGenerateVideo ||
									goalControls ||
									ghostControls ||
									pluginControls?.length ||
									composerMenuGroups?.some((group) => group.items.length > 0) ||
									contextMeter ||
									expandComposer) &&
									composerToolbar}
							</>
						)}
					</motion.div>
				)}
			</AnimatePresence>
		</motion.div>
	);

	return (
		<div className={cn("shrink-0 px-3 pb-3", className)} ref={containerRef}>
			<motion.div
				className={cn(
					"mx-auto w-full",
					isExpanded ? "max-w-[980px]" : "max-w-[880px]"
				)}
				transition={composerTransition}
			>
				{showTurnProgress ? (
					<div
						aria-live="polite"
						className="mb-2 flex flex-wrap items-center justify-center gap-1.5 text-[13px]"
					>
						{turnProgress?.todos ? (
							<Popover>
								<PopoverTrigger
									render={
										<button
											className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/30 bg-popover/80 px-2 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
											data-testid="turn-progress-steps"
											type="button"
										/>
									}
								>
									<IconLoader2 className="size-3.5 text-primary" />
									<span>
										Step {turnProgress.todos.current} of{" "}
										{turnProgress.todos.total}
									</span>
								</PopoverTrigger>
								<PopoverContent
									align="center"
									className="max-h-80 w-[min(24rem,calc(100vw-2rem))] gap-0 overflow-y-auto rounded-2xl p-2"
									side="top"
									sideOffset={8}
								>
									{turnProgress.todos.items.map((item, index) => {
										const TodoIcon =
											item.status === "completed"
												? IconCircleCheck
												: item.status === "in_progress"
													? IconLoader2
													: IconCircle;
										return (
											<div
												className="flex items-start gap-2 rounded-xl px-2 py-1.5 text-sm"
												key={`${index}-${item.label}`}
											>
												<TodoIcon
													className={cn(
														"mt-0.5 size-4 shrink-0",
														item.status === "in_progress" &&
															cn(
																"text-primary",
																!reduceMotion && "animate-spin"
															)
													)}
												/>
												<span>{item.label}</span>
											</div>
										);
									})}
								</PopoverContent>
							</Popover>
						) : null}
						{showChangeSummary && effectiveChangeSummary ? (
							<Popover>
								<PopoverTrigger
									render={
										<button
											className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/30 bg-popover/80 px-2 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
											data-testid="turn-progress-files"
											type="button"
										/>
									}
								>
									<span>
										{formatNumber(effectiveChangeSummary.files)} file
										{effectiveChangeSummary.files === 1 ? "" : "s"} changed
									</span>
									<span className="font-medium text-emerald-600 dark:text-emerald-400">
										+{formatNumber(effectiveChangeSummary.insertions)}
									</span>
									<span className="font-medium text-red-600 dark:text-red-400">
										-{formatNumber(effectiveChangeSummary.deletions)}
									</span>
								</PopoverTrigger>
								{turnProgress?.files.length ? (
									<PopoverContent
										align="center"
										className="max-h-80 w-[min(24rem,calc(100vw-2rem))] gap-0 overflow-y-auto rounded-2xl p-1.5"
										side="top"
										sideOffset={8}
									>
										{turnProgress.files.map((file) => (
											<TurnProgressFile file={file} key={file.path} />
										))}
									</PopoverContent>
								) : null}
							</Popover>
						) : null}
					</div>
				) : null}
				<div
					className={cn(
						"flex flex-col gap-0",
						// Reference architecture: the outer wrapper is the FRAME color
						// (distinct from the input box), so the bars — which carry no bg of
						// their own — show this color, and the sliver at the input box's
						// rounded corners is the same color as the bars (seamless).
						!seamless && (shouldShowInfoBar || goalBar || workspaceBar || ghost)
							? "rounded-2xl bg-card"
							: null
					)}
				>
					{goalBar && <GoalBar {...goalBar} />}
					{ghostBarNode}
					{infoBarPosition === "top" && infoBarNode}
					{queueBarNode}
					{renderComposerSurface(isExpanded)}
					{renderComposerSuggestions(isExpanded)}
					{infoBarPosition === "bottom" && infoBarNode}
					{/* Action bar (project ▸ branch ▸ worktree): full-width footer inside
					    the card, directly beneath the input — same slot as the bottom
					    info bar. */}
					{actionBarNode}
				</div>
			</motion.div>
		</div>
	);
});
