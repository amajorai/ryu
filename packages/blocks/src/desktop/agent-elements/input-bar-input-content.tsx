"use client";

import { ComposerEditor } from "@ryu/ui/components/editor/composer-editor.tsx";
import { importMentionMarkdown } from "@ryu/ui/components/editor/composer-mention-markdown.ts";
import { Wave } from "@ryu/ui/components/wave";
import { cn } from "@ryu/ui/lib/utils";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import type { SuggestionItem } from "./input/suggestions.tsx";
import styles from "./input-bar.module.css";
import { MentionToken } from "./mention-token.tsx";
import type { MentionItem } from "./types.ts";
import type { useComposerTokenDrag } from "./use-composer-token-drag.ts";

/**
 * Bars in the full-width recording waveform that replaces the textarea while the
 * mic is live. High enough to read as a dense, ChatGPT-style waveform spanning
 * the whole input; the recorder keeps a longer amplitude history to feed these.
 */
const RECORDING_WAVE_BARS = 48;

export interface ComposerInputContentProps {
	composerPreviewRef: RefObject<HTMLDivElement | null>;
	composerSuggestions: SuggestionItem[];
	disabled?: boolean;
	displayedText: string;
	effectivePlaceholder: string;
	ghostSuggestion?: string;
	handleComposerCopy: (event: React.ClipboardEvent<HTMLElement>) => void;
	handleComposerPaste: (event: React.ClipboardEvent<HTMLElement>) => void;
	handleKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
	handleSuggestionSelect: (item: SuggestionItem) => void;
	input: string;
	isCompactSingleRow: boolean;
	isRecording: boolean;
	isTyping: boolean;
	markdownComposer: boolean;
	mentionItems: MentionItem[] | undefined;
	prediction?: string;
	renderComposerPreview: () => ReactNode[];
	richEditorRef: RefObject<HTMLDivElement | null>;
	setInput: (v: string) => void;
	setSuggestionIndex: Dispatch<SetStateAction<number>>;
	showComposerSuggestions: boolean;
	showPlaceholderSuggestion: boolean;
	suggestionIndex: number;
	textareaAriaLabel?: string;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	tokenDrag: ReturnType<typeof useComposerTokenDrag>;
	voiceLevels: number[];
}

/**
 * The textarea (or its typing-animation stand-in). A one-line compact textarea
 * is threaded through the toolbar as its flexible centre. Once it wraps, the
 * same node moves into the full padded block above the controls row.
 *
 * While recording, the textarea is REPLACED (not overlaid) by a full-width
 * live waveform that fills the input slot — like ChatGPT. Swapping it out (vs
 * covering it) means text input is inherently disallowed (there is no textarea
 * to type into), the focus ring stays untouched, and the stop control in the
 * toolbar below/beside stays reachable. Any text already typed lives in `input`
 * state (not the DOM), so it reappears intact when recording stops.
 */
export function ComposerInputContent({
	composerPreviewRef,
	composerSuggestions,
	disabled,
	displayedText,
	effectivePlaceholder,
	ghostSuggestion,
	handleComposerCopy,
	handleComposerPaste,
	handleKeyDown,
	handleSuggestionSelect,
	input,
	isCompactSingleRow,
	isRecording,
	isTyping,
	markdownComposer,
	mentionItems,
	prediction,
	renderComposerPreview,
	richEditorRef,
	setInput,
	setSuggestionIndex,
	showComposerSuggestions,
	showPlaceholderSuggestion,
	suggestionIndex,
	textareaAriaLabel,
	textareaRef,
	tokenDrag,
	voiceLevels,
}: ComposerInputContentProps) {
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

	let inputContent: React.ReactNode;
	if (isTyping) {
		inputContent = (
			<div className="text-(length:--text-comfortable) w-full text-muted-foreground leading-(--text-comfortable--line-height)">
				<span>{displayedText}</span>
				<span className={styles.caret} />
			</div>
		);
	} else if (isRecording) {
		inputContent = (
			<span className="flex h-6 w-full text-primary">
				<Wave
					aria-label="Recording"
					barCount={RECORDING_WAVE_BARS}
					className="h-6 w-full"
					levels={voiceLevels}
				/>
			</span>
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
					onPaste={handleComposerPaste}
					placeholder={
						showPlaceholderSuggestion && prediction
							? prediction
							: effectivePlaceholder
					}
				/>
			</div>
		);
	} else {
		inputContent = (
			<div className="relative w-full">
				{showPlaceholderSuggestion && (
					<div
						aria-hidden="true"
						className="text-(length:--text-comfortable) pointer-events-none absolute inset-x-0 top-0 z-10 truncate text-muted-foreground leading-(--text-comfortable--line-height)"
						data-slot="composer-placeholder-suggestion"
					>
						{ghostSuggestion}
						<span className="ml-2 rounded-lg border border-border px-1.5 py-0.5 text-xs">
							Tab
						</span>
					</div>
				)}
				{showComposerSuggestions && suggestionIndex >= 0 && (
					<div className="absolute inset-x-0 top-full z-20 mt-1 rounded-xl border border-border bg-popover p-1.5 shadow-lg">
						{composerSuggestions.map((item, index) => (
							<button
								className={cn(
									"block h-8 w-full rounded-lg px-2 text-left text-sm",
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
						className="text-(length:--text-comfortable) pointer-events-none absolute inset-0 whitespace-pre-wrap break-words text-foreground leading-(--text-comfortable--line-height)"
						ref={composerPreviewRef}
					>
						{renderComposerPreview()}
					</div>
				)}
				<textarea
					aria-label={textareaAriaLabel}
					className={cn(
						"text-(length:--text-comfortable) relative w-full resize-none border-0 bg-transparent text-transparent leading-(--text-comfortable--line-height) caret-foreground outline-none placeholder:text-muted-foreground",
						"overflow-hidden",
						// The one-line row leaves the textarea little width on a narrow
						// pane; a wrapping placeholder would size the empty box to two
						// or three lines, so it stays on one line there.
						isCompactSingleRow && "placeholder:truncate",
						showPlaceholderSuggestion && "placeholder:text-transparent",
						disabled && "cursor-not-allowed opacity-50"
					)}
					disabled={disabled}
					onChange={(e) => {
						setSuggestionIndex(-1);
						setInput(e.target.value);
					}}
					onCopy={handleComposerCopy}
					onKeyDown={handleKeyDown}
					onPaste={handleComposerPaste}
					{...tokenDrag.handlers}
					placeholder={effectivePlaceholder}
					ref={textareaRef}
					rows={1}
					value={input}
				/>
			</div>
		);
	}
	return inputContent;
}

/**
 * Keep the editor in one stable Motion slot. The toolbar changes its grid/flex
 * topology around that slot when a compact draft reaches a second visible line,
 * allowing the shared layout transition to morph the card instead of replacing
 * the textarea and controls with a new subtree.
 */
export function ComposerEditorSlot({
	inputContent,
	isCompactSingleRow,
	isExpanded,
	liveCall,
}: {
	inputContent: ReactNode;
	isCompactSingleRow: boolean;
	isExpanded: boolean;
	liveCall?: { content: ReactNode };
}) {
	return liveCall ? (
		<div
			className="flex min-h-10 min-w-0 flex-1 items-center"
			data-slot="composer-live-call"
		>
			{liveCall.content}
		</div>
	) : (
		<div
			className={cn(
				"w-full",
				isCompactSingleRow
					? "flex min-h-8 min-w-0 flex-1 items-center"
					: isExpanded
						? "min-h-[320px] pt-4 pr-14 pb-3 pl-5"
						: "flex min-h-16 flex-col justify-center px-3 py-2"
			)}
		>
			{inputContent}
		</div>
	);
}

/** Normalise the `suggestions` prop (bare list or list with class names). */
export function resolveComposerSuggestions(
	suggestions:
		| SuggestionItem[]
		| {
				items: SuggestionItem[];
				className?: string;
				itemClassName?: string;
		  }
) {
	const suggestionItems = Array.isArray(suggestions)
		? suggestions
		: (suggestions?.items ?? []);
	const suggestionsContainerClassName = Array.isArray(suggestions)
		? undefined
		: suggestions?.className;
	const suggestionButtonClassName = Array.isArray(suggestions)
		? undefined
		: suggestions?.itemClassName;
	return {
		suggestionButtonClassName,
		suggestionItems,
		suggestionsContainerClassName,
	};
}
