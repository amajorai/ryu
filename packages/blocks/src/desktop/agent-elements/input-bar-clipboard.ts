"use client";

import {
	exportMentionMarkdown,
	importMentionMarkdown,
} from "@ryu/ui/components/editor/composer-mention-markdown.ts";
import { type RefObject, useCallback } from "react";
import type { MentionItem } from "./types.ts";

/**
 * Plain-textarea paste/copy handlers that translate between mention tokens and
 * their Markdown form (the rich Markdown composer handles its own clipboard).
 */
export function useComposerClipboard({
	input,
	markdownComposer,
	mentionItems,
	onPaste,
	setInput,
	textareaRef,
}: {
	input: string;
	markdownComposer: boolean;
	mentionItems: MentionItem[] | undefined;
	onPaste: ((e: React.ClipboardEvent) => void) | undefined;
	setInput: (v: string) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
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
	return { handleComposerCopy, handleComposerPaste };
}
