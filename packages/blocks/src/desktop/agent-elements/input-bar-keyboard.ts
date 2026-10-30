"use client";

import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
} from "react";
import {
	type ComposerSendShortcut,
	isImeComposingKeyEvent,
	resolveComposerKeyAction,
} from "./composer-send-shortcut.ts";
import type { InputBarProps } from "./input-bar-types.ts";

/** Send the draft, or with an empty composer send the first queued message. */
export function useComposerSubmit({
	disabled,
	enableQueue,
	hasInput,
	input,
	isStreaming,
	onSend,
	queueBar,
	setInput,
}: {
	disabled?: boolean;
	enableQueue?: boolean;
	hasInput: boolean;
	input: string;
	isStreaming: boolean;
	onSend: InputBarProps["onSend"];
	queueBar: InputBarProps["queueBar"];
	setInput: (v: string) => void;
}) {
	return useCallback(
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
}

/** Composer keyboard handling: prompt list, ghost suggestion, send shortcut. */
export function useComposerKeyDown({
	composerSendShortcut,
	handleSubmit,
	input,
	isExpanded,
	isStreaming,
	markdownComposer,
	onTextareaKeyDown,
	placeholderSuggestion,
	prediction,
	richEditorRef,
	setInput,
	setIsExpanded,
	setSuggestionIndex,
	suggestionIndex,
	suggestions,
}: {
	composerSendShortcut: ComposerSendShortcut;
	handleSubmit: (followUpMode?: "opposite") => void;
	input: string;
	isExpanded: boolean;
	isStreaming: boolean;
	markdownComposer: boolean;
	onTextareaKeyDown: InputBarProps["onTextareaKeyDown"];
	placeholderSuggestion?: string;
	prediction?: string;
	richEditorRef: RefObject<HTMLDivElement | null>;
	setInput: (v: string) => void;
	setIsExpanded: Dispatch<SetStateAction<boolean>>;
	setSuggestionIndex: Dispatch<SetStateAction<number>>;
	suggestionIndex: number;
	suggestions: NonNullable<InputBarProps["suggestions"]>;
}) {
	return useCallback(
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
}
