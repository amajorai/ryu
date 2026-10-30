import { useCallback, useEffect, useRef, useState } from "react";
import { hasComposerInput } from "./input/composer-input.ts";
import { useInputTyping } from "./input/input-typing.tsx";
import {
	textareaWrapsAtWidth,
	useSafeLayoutEffect,
} from "./input-bar-helpers.tsx";
import type { InputBarBaseScope } from "./input-bar-scope.ts";
import type { useInputBarState } from "./input-bar-state.tsx";

export type UseComposerAutoGrowInput = InputBarBaseScope &
	ReturnType<typeof useInputBarState>;

/** Media generation and typing state, plus the textarea measurement that grows the composer. */
export function useComposerAutoGrow({
	input,
	setInput,
	onGenerateImage,
	onGenerateVideo,
	status,
	typingAnimation,
	enableQueue,
	config,
	placeholder,
	onAttach,
	markdownComposer,
	setIsCompactTextareaMultiline,
	textareaRef,
	isExpanded,
	isCompactSingleRow,
	compactTextareaWidthRef,
	compact,
	containerRef,
	focusComposer,
	autoFocus,
	attachedImages,
	attachedFiles,
}: UseComposerAutoGrowInput) {
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

	// Auto-resize textarea. `measureTextareaRef` holds the latest measurement and
	// `measuredTextareaWidthRef` the width it measured at, so the pane observer
	// below can repeat it without adding dependencies here.
	const measureTextareaRef = useRef<() => void>(() => undefined);
	const measuredTextareaWidthRef = useRef(0);
	// What the last measurement sized the box for. Typing at the end of the
	// draft can only keep or grow its height, so that common keystroke skips
	// the collapse-to-0 pass: one layout read instead of a write/read/write
	// thrash per key.
	const lastMeasuredRef = useRef<{
		element: HTMLTextAreaElement;
		expanded: boolean;
		input: string;
	} | null>(null);
	useSafeLayoutEffect(() => {
		const measure = (collapse = true) => {
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
			// Read the width before any write: the box's height never changes it.
			const renderedWidth = el.getBoundingClientRect().width;
			const last = lastMeasuredRef.current;
			// An empty box was sized for its placeholder, which can wrap onto
			// more lines than the first typed characters: that keystroke must
			// collapse, or the box keeps the placeholder's height.
			const onlyGrew =
				!collapse &&
				last !== null &&
				// A remounted textarea has none of the height set below.
				last.element === el &&
				last.input !== "" &&
				last.expanded === isExpanded &&
				renderedWidth === measuredTextareaWidthRef.current &&
				input.startsWith(last.input);
			if (!onlyGrew) {
				el.style.height = "0";
			}
			// Uncollapsed, this is max(content, current height), and the current
			// height already fits everything but the appended text.
			const contentHeight = el.scrollHeight;
			const nextHeight = Math.min(
				Math.max(contentHeight, minHeight),
				maxHeight
			);
			el.style.height = `${nextHeight}px`;
			el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
			el.style.overflowX = "hidden";
			measuredTextareaWidthRef.current = renderedWidth;
			lastMeasuredRef.current = { element: el, expanded: isExpanded, input };

			if (!compact) {
				setIsCompactTextareaMultiline(false);
				return;
			}
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
		};
		measureTextareaRef.current = measure;
		measure(false);
		// Re-measure on every value change so the textarea grows/shrinks with its
		// content (one row by default, expanding up to the 120px cap, or the
		// roomier expanded cap). Without
		// `input` in the deps this only ran on mount and the box never resized.
		// A repo-wide lint/format sweep (9fed37659) emptied this array once already
		// and the composer went back to a permanently one-line box — `input` is
		// load-bearing, not a lint artefact.
	}, [compact, input, isCompactSingleRow, isExpanded, markdownComposer]);

	// The measurement above reads 0 whenever the composer is not rendered: a
	// retained tab mounts through a detached portal container and is parked
	// under `display: none` while another tab is focused. None of its
	// dependencies change when the tab is revealed, so it would keep a 0px
	// textarea. Watch the always-mounted composer root and repeat the
	// measurement when the textarea's rendered width no longer matches the
	// width it was measured at: hidden to shown, or a pane resize that re-wraps
	// the draft. Height-only changes (including the ones this measurement
	// causes) are ignored, and the work runs in the next frame so it never
	// resizes an observed element inside the observer callback.
	useEffect(() => {
		const root = containerRef.current;
		if (!root || globalThis.ResizeObserver === undefined) {
			return;
		}
		let frame = 0;
		const observer = new ResizeObserver(() => {
			const textarea = textareaRef.current;
			if (
				!textarea ||
				textarea.getBoundingClientRect().width ===
					measuredTextareaWidthRef.current
			) {
				return;
			}
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => measureTextareaRef.current());
		});
		observer.observe(root);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, []);

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
	return {
		isGenerating,
		handleGenerateImage,
		isGeneratingVideo,
		handleGenerateVideo,
		isStreaming,
		isTyping,
		displayedText,
		showImage,
		effectivePlaceholder,
		showAttach,
		hasContextItems,
		hasInput,
	} as const;
}
