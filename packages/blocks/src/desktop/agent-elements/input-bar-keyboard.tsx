import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { importMentionMarkdown } from "@ryu/ui/components/editor/composer-mention-markdown.ts";
import { EASE_OUT } from "@ryu/ui/lib/ease";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import { type ReactNode, useCallback, useRef } from "react";
import {
	isImeComposingKeyEvent,
	resolveComposerKeyAction,
} from "./composer-send-shortcut.ts";
import type { SuggestionItem } from "./input/suggestions.tsx";
import type { useComposerAutoGrow } from "./input-bar-auto-grow.ts";
import type { useInputBarBars } from "./input-bar-bars.tsx";
import type { InputBarBaseScope } from "./input-bar-scope.ts";
import type { useInputBarState } from "./input-bar-state.tsx";
import { findMentionAt } from "./mention-format.ts";
import { MentionToken } from "./mention-token.tsx";
import type { MentionItem } from "./types.ts";
import { useComposerTokenDrag } from "./use-composer-token-drag.ts";

export type UseInputBarKeyboardInput = InputBarBaseScope &
	ReturnType<typeof useInputBarState> &
	ReturnType<typeof useComposerAutoGrow> &
	ReturnType<typeof useInputBarBars>;

/** Keyboard handling, suggestions, and the rich composer preview. */
export function useInputBarKeyboard({
	markdownComposer,
	richEditorRef,
	isExpanded,
	setIsExpanded,
	input,
	isStreaming,
	setInput,
	setSuggestionIndex,
	suggestionIndex,
	composerSendShortcut,
	handleSubmit,
	onTextareaKeyDown,
	suggestions,
	prediction,
	placeholderSuggestion,
	hasInput,
	hasContextItems,
	config,
	typingAnimation,
	turnProgress,
	changeSummary,
	focusComposer,
	textareaRef,
	disabled,
	reduceMotion,
	mentionItems,
}: UseInputBarKeyboardInput) {
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLElement>) => {
			onTextareaKeyDown?.(e);
			if (e.defaultPrevented) {
				return;
			}
			// Enter/Tab/Arrow/Escape during an IME composition belong to the
			// candidate window, not the composer (CJK input would send early).
			if (isImeComposingKeyEvent(e.nativeEvent)) {
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
			const ghostSuggestion = prediction || placeholderSuggestion;
			if (
				!(input.trim() || isStreaming) &&
				e.key === "Tab" &&
				ghostSuggestion
			) {
				e.preventDefault();
				setInput(ghostSuggestion);
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
			placeholderSuggestion,
			prediction,
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
	const ghostSuggestion = prediction || placeholderSuggestion;
	// A prediction stands on its own; a placeholder prompt only previews a list.
	const showPlaceholderSuggestion =
		!(hasInput || isStreaming) &&
		suggestionIndex < 0 &&
		(Boolean(prediction) ||
			(showComposerSuggestions && Boolean(placeholderSuggestion)));
	const showContextItems =
		hasContextItems && config.attachmentPreviewStyle !== "hidden";
	const safeTypingAnimationImage = safeMediaUrl(typingAnimation?.image);
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
			// SAFETY: This callback is the native motion.div click handler below; React DOM normalizes text-node click targets to their parent Element and retains SVG targets. Only Element.closest is used here, so no HTMLElement-specific fields are claimed.
			const target = e.target as Element;
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
	const composerPreviewRef = useRef<HTMLDivElement>(null);
	const tokenDrag = useComposerTokenDrag({
		enabled: !disabled,
		input,
		overlayRef: composerPreviewRef,
		setInput,
		textareaRef,
	});
	const draggingTokenStart = tokenDrag.draggingStart;
	const tokenDropGap = tokenDrag.dropGap;
	const renderComposerPreview = useCallback((): ReactNode[] => {
		const parts: ReactNode[] = [];
		let cursor = 0;
		// While a chip is dragged, the text after its landing spot slides aside
		// to open a chip-wide gap there (the textarea's own text is transparent,
		// so only this overlay reflows).
		let gapPending = tokenDropGap !== null;
		const pushGapAt = (position: number) => {
			if (!(gapPending && tokenDropGap?.index === position)) {
				return;
			}
			gapPending = false;
			parts.push(
				<motion.span
					animate={{ width: tokenDropGap.width }}
					aria-hidden="true"
					className="inline-block h-[1em] align-[-0.125em]"
					data-slot="composer-token-drop-gap"
					initial={{ width: 0 }}
					key={`gap-${position}`}
					transition={
						reduceMotion ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }
					}
				/>
			);
		};
		// Text runs and chips carry their draft offsets so a dragged chip can be
		// hit-tested and dropped by measuring this overlay's layout.
		const pushRun = (start: number, end: number) => {
			if (end > start) {
				parts.push(
					<span data-composer-text-start={start} key={`text-${start}`}>
						{input.slice(start, end)}
					</span>
				);
			}
		};
		const pushText = (start: number, end: number) => {
			const gapIndex = tokenDropGap?.index ?? -1;
			if (gapPending && gapIndex >= start && gapIndex < end) {
				pushRun(start, gapIndex);
				pushGapAt(gapIndex);
				pushRun(gapIndex, end);
				return;
			}
			pushRun(start, end);
		};
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
			pushText(cursor, index);
			pushGapAt(index);
			const token = input.slice(index, end);
			parts.push(
				mention?.item ? (
					<span
						className={cn(
							"transition-opacity",
							draggingTokenStart === index && "opacity-40"
						)}
						data-composer-token-end={end}
						data-composer-token-start={index}
						key={`${index}-${token}`}
					>
						<MentionToken item={mention.item}>
							{mention.item.label}
						</MentionToken>
					</span>
				) : (
					<span className="font-medium text-primary" key={`${index}-${token}`}>
						<HugeiconsIcon
							aria-hidden="true"
							className="mr-1 inline-flex size-3.5 align-[-2px]"
							icon={Globe02Icon}
						/>
						{token}
					</span>
				)
			);
			cursor = end;
			index = end - 1;
		}
		pushText(cursor, input.length);
		pushGapAt(input.length);
		return parts;
	}, [draggingTokenStart, input, mentionItems, reduceMotion, tokenDropGap]);

	const suggestionItems = Array.isArray(suggestions)
		? suggestions
		: (suggestions?.items ?? []);
	const suggestionsContainerClassName = Array.isArray(suggestions)
		? undefined
		: suggestions?.className;
	const suggestionButtonClassName = Array.isArray(suggestions)
		? undefined
		: suggestions?.itemClassName;
	const handleRichChange = useCallback(
		(next: string) => {
			setSuggestionIndex(-1);
			setInput(importMentionMarkdown(next, mentionItems ?? []));
		},
		[mentionItems, setInput]
	);
	const renderRichMention = useCallback(
		(label: string, item?: MentionItem) => (
			<MentionToken item={item}>{label}</MentionToken>
		),
		[]
	);
	return {
		handleKeyDown,
		composerSuggestions,
		showComposerSuggestions,
		ghostSuggestion,
		showPlaceholderSuggestion,
		showContextItems,
		safeTypingAnimationImage,
		imageDisplayMode,
		effectiveChangeSummary,
		showChangeSummary,
		showTurnProgress,
		handleContainerClick,
		handleSuggestionSelect,
		composerPreviewRef,
		tokenDrag,
		renderComposerPreview,
		suggestionItems,
		suggestionsContainerClassName,
		suggestionButtonClassName,
		handleRichChange,
		renderRichMention,
	} as const;
}
