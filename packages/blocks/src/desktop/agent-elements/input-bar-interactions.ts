"use client";

import { type RefObject, useCallback, useEffect, useState } from "react";
import type { SuggestionItem } from "./input/suggestions.tsx";

/** Plugin-owned in-place expansion of the composer. */
export function useComposerExpansion({
	expandComposer,
	focusComposer,
}: {
	expandComposer?: boolean;
	focusComposer: () => void;
}) {
	const [isExpanded, setIsExpanded] = useState(false);

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

	return { isExpanded, openExpandedComposer, setIsExpanded };
}

/** Clicking the composer card focuses the editor unless a control was hit. */
export function useComposerContainerClick(focusComposer: () => void) {
	return useCallback(
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
}

/** Pick a prompt suggestion into the composer and place the caret at its end. */
export function useComposerSuggestionSelect({
	disabled,
	focusComposer,
	isStreaming,
	markdownComposer,
	setInput,
	textareaRef,
}: {
	disabled?: boolean;
	focusComposer: () => void;
	isStreaming: boolean;
	markdownComposer: boolean;
	setInput: (v: string) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
	return useCallback(
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
}
