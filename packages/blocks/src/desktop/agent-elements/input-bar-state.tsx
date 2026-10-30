import { File01Icon, Image01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	exportMentionMarkdown,
	importMentionMarkdown,
} from "@ryu/ui/components/editor/composer-mention-markdown.ts";
import { useMediaQuery } from "@ryu/ui/hooks/use-mobile.ts";
import { SPRING_MORPH } from "@ryu/ui/lib/ease";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import {
	appendAttachmentMentions,
	attachmentMentionItem,
	labelComposerAttachments,
	remapAttachmentMentions,
} from "./composer-attachment-mentions.ts";
import { useDraftSave } from "./input/use-draft-save.ts";
import { DEFAULT_INPUT_CONFIG, noopTranscribe } from "./input-bar-helpers.tsx";
import type { InputBarBaseScope } from "./input-bar-scope.ts";
import type { InputBarInfoBar } from "./input-bar-types.ts";
import type { MentionItem } from "./types.ts";
import { useVoiceRecorder } from "./useVoiceRecorder.ts";

export type UseInputBarStateInput = InputBarBaseScope;

/** Composer text, mentions, clipboard, layout mode and voice recording. */
export function useInputBarState({
	value: controlledValue,
	onChange: controlledOnChange,
	attachedImages,
	attachedFiles,
	mentionItems: hostMentionItems,
	draftControls,
	onPaste,
	compact,
	onHeightChange,
	expandComposer,
	voice,
	infoBar,
}: UseInputBarStateInput) {
	const [internalInput, setInternalInput] = useState("");
	const [isInfoBarOpen, setIsInfoBarOpen] = useState(true);
	const [dismissedQuestionId, setDismissedQuestionId] = useState<string | null>(
		null
	);
	const [questionBarIndex, setQuestionBarIndex] = useState(1);
	const [suggestionIndex, setSuggestionIndex] = useState(-1);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const richEditorRef = useRef<HTMLDivElement>(null);
	const { animationsEnabled, composerSendShortcut, markdownComposer } =
		useChatDisplayPrefs();
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
	// Staged attachments are mentionable too: `@image-1`, `@file-1`, … resolve
	// to chips (with the image's own thumbnail) alongside the host's directory.
	const attachmentLabels = useMemo(
		() => labelComposerAttachments(attachedImages, attachedFiles),
		[attachedImages, attachedFiles]
	);
	const mentionItems = useMemo((): MentionItem[] | undefined => {
		if (attachmentLabels.length === 0) {
			return hostMentionItems;
		}
		const attachmentItems = attachmentLabels.map((attachment) => {
			const thumbnail = attachment.url ? safeMediaUrl(attachment.url) : null;
			return {
				...attachmentMentionItem(attachment),
				icon:
					attachment.kind === "image" ? (
						<HugeiconsIcon className="size-3.5" icon={Image01Icon} />
					) : (
						<HugeiconsIcon className="size-3.5" icon={File01Icon} />
					),
				visualIcon: thumbnail ? (
					<img
						alt=""
						className="size-3.5 rounded-[3px] object-cover"
						draggable={false}
						height={14}
						src={thumbnail}
						width={14}
					/>
				) : undefined,
			};
		});
		return [...attachmentItems, ...(hostMentionItems ?? [])];
	}, [attachmentLabels, hostMentionItems]);
	// Each newly staged attachment appends its token to the end of the draft;
	// removing one drops its token and renumbers the rest so every token keeps
	// pointing at the same file. Seeded with the mount-time list so a remount
	// never re-appends tokens the user already deleted.
	const inputRef = useRef(input);
	inputRef.current = input;
	const previousAttachmentLabelsRef = useRef(attachmentLabels);
	useEffect(() => {
		const previous = previousAttachmentLabelsRef.current;
		if (previous === attachmentLabels) {
			return;
		}
		previousAttachmentLabelsRef.current = attachmentLabels;
		const current = inputRef.current;
		const previousIds = new Set(previous.map((item) => item.id));
		const next = appendAttachmentMentions(
			remapAttachmentMentions(current, previous, attachmentLabels),
			attachmentLabels.filter((item) => !previousIds.has(item.id))
		);
		if (next !== current) {
			inputRef.current = next;
			setInput(next);
		}
	}, [attachmentLabels, setInput]);
	const draftSave = useDraftSave(input, setInput, draftControls?.onSave);
	const handleComposerPaste = useCallback(
		(event: React.ClipboardEvent<HTMLElement>) => {
			onPaste?.(event);
			if (event.defaultPrevented || markdownComposer) {
				return;
			}
			const pastedText = event.clipboardData.getData("text/plain");
			const normalizedText = importMentionMarkdown(
				pastedText,
				mentionItems ?? []
			);
			if (normalizedText === pastedText) {
				return;
			}
			const textarea = event.currentTarget;
			if (!(textarea instanceof HTMLTextAreaElement)) {
				return;
			}
			event.preventDefault();
			const start = textarea.selectionStart;
			const end = textarea.selectionEnd;
			const next = `${input.slice(0, start)}${normalizedText}${input.slice(end)}`;
			setInput(next);
			const caret = start + normalizedText.length;
			requestAnimationFrame(() => {
				if (textareaRef.current === textarea) {
					textarea.focus();
					textarea.setSelectionRange(caret, caret);
				}
			});
		},
		[input, markdownComposer, mentionItems, onPaste, setInput]
	);
	const handleComposerCopy = useCallback(
		(event: React.ClipboardEvent<HTMLElement>) => {
			if (markdownComposer) {
				return;
			}
			const textarea = event.currentTarget;
			if (!(textarea instanceof HTMLTextAreaElement)) {
				return;
			}
			const selectedText = input.slice(
				textarea.selectionStart,
				textarea.selectionEnd
			);
			const markdown = exportMentionMarkdown(selectedText, mentionItems ?? []);
			if (markdown !== selectedText) {
				event.preventDefault();
				event.clipboardData.setData("text/plain", markdown);
			}
		},
		[input, markdownComposer, mentionItems]
	);
	const containerRef = useRef<HTMLDivElement>(null);
	const compactTextareaWidthRef = useRef<number | null>(null);
	const [isCompactTextareaMultiline, setIsCompactTextareaMultiline] =
		useState(false);
	const [plusMenuQueryStart, setPlusMenuQueryStart] = useState<number | null>(
		null
	);
	const config = DEFAULT_INPUT_CONFIG;
	const [isExpanded, setIsExpanded] = useState(false);
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
	const prefersReducedMotion = useMediaQuery(
		"(prefers-reduced-motion: reduce)"
	);
	const reduceMotion = !animationsEnabled || prefersReducedMotion;
	const composerTransition = reduceMotion ? { duration: 0 } : SPRING_MORPH;

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
		if (globalThis.ResizeObserver === undefined) {
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
	return {
		isInfoBarOpen,
		setIsInfoBarOpen,
		dismissedQuestionId,
		setDismissedQuestionId,
		questionBarIndex,
		setQuestionBarIndex,
		suggestionIndex,
		setSuggestionIndex,
		textareaRef,
		richEditorRef,
		composerSendShortcut,
		markdownComposer,
		input,
		setInput,
		mentionItems,
		draftSave,
		handleComposerPaste,
		handleComposerCopy,
		containerRef,
		compactTextareaWidthRef,
		setIsCompactTextareaMultiline,
		plusMenuQueryStart,
		setPlusMenuQueryStart,
		config,
		isExpanded,
		setIsExpanded,
		isCompactSingleRow,
		focusComposer,
		reduceMotion,
		composerTransition,
		openExpandedComposer,
		voiceLevels,
		voiceError,
		clearVoiceError,
		startVoice,
		stopVoice,
		isRecording,
		isTranscribing,
		effectiveInfoBar,
	} as const;
}
