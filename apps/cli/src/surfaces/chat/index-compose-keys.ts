// Chat keyboard: composer keys, recent-chat resume, prompt history, paste
// collapsing, Esc interrupt and the focused pane's key routing.

import {
	decodePasteBytes,
	type KeyEvent,
	type PasteEvent,
	stripAnsiSequences,
} from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback } from "react";
import { moveAutocompleteIndex, runsOnEnter } from "../../core/autocomplete.ts";
import {
	normalizePastedText,
	pastePlaceholderToken,
	shouldCollapsePaste,
} from "../../core/composerPaste.ts";
import { deleteConversation } from "../../core/conversations.ts";
import { nativeErrorMessage as errText } from "../../core/native-errors.ts";
import { nextPrompt, previousPrompt } from "../../core/promptHistory.ts";
import { tf } from "../../i18n/translate.ts";
import type { ChatSurfaceContext } from "./index-context.ts";
import { transcriptScrollForKey } from "./transcriptScroll.tsx";

type UseChatComposeKeysDeps = Pick<
	ChatSurfaceContext,
	| "abortRef"
	| "applySelectedAutocomplete"
	| "autocomplete"
	| "cancelActiveTurn"
	| "clearQueuedMessages"
	| "clearTurnActivity"
	| "composer"
	| "composerInputRef"
	| "composerRef"
	| "conversationIdRef"
	| "externalOverlayId"
	| "focused"
	| "handleAcpKey"
	| "handleAgentKey"
	| "handleModelKey"
	| "handlePermissionKey"
	| "handleQuestionKey"
	| "handleTeamKey"
	| "messages"
	| "notify"
	| "openAcpPicker"
	| "openAgentPicker"
	| "overlay"
	| "paneHasManyTabs"
	| "pasteSequenceRef"
	| "pastedTextRef"
	| "pendingStopRef"
	| "queueFocused"
	| "queuePaused"
	| "queuedMessages"
	| "recentRows"
	| "resetChat"
	| "runResume"
	| "setAutocomplete"
	| "setComposerText"
	| "setExpandPrompts"
	| "setMessages"
	| "setOverlay"
	| "setQueueFocused"
	| "setQueuePaused"
	| "setQueueSelectedIndex"
	| "setStreaming"
	| "shellKeyboardCaptured"
	| "simpleInterface"
	| "streaming"
	| "submitComposer"
	| "target"
	| "transcriptScroll"
	| "updatePromptHistory"
	| "visibleRecentCount"
>;

export function useChatComposeKeys(deps: UseChatComposeKeysDeps) {
	const {
		abortRef,
		applySelectedAutocomplete,
		autocomplete,
		cancelActiveTurn,
		clearQueuedMessages,
		clearTurnActivity,
		composer,
		composerInputRef,
		composerRef,
		conversationIdRef,
		externalOverlayId,
		focused,
		handleAcpKey,
		handleAgentKey,
		handleModelKey,
		handlePermissionKey,
		handleQuestionKey,
		handleTeamKey,
		messages,
		notify,
		openAcpPicker,
		openAgentPicker,
		overlay,
		paneHasManyTabs,
		pasteSequenceRef,
		pastedTextRef,
		pendingStopRef,
		queueFocused,
		queuePaused,
		queuedMessages,
		recentRows,
		resetChat,
		runResume,
		setAutocomplete,
		setComposerText,
		setExpandPrompts,
		setMessages,
		setOverlay,
		setQueueFocused,
		setQueuePaused,
		setQueueSelectedIndex,
		setStreaming,
		shellKeyboardCaptured,
		simpleInterface,
		streaming,
		submitComposer,
		target,
		transcriptScroll,
		updatePromptHistory,
		visibleRecentCount,
	} = deps;
	const confirmDelete = useCallback(() => {
		if (overlay.kind !== "delete") {
			return;
		}
		const id = overlay.conversationId;
		setOverlay({ kind: "none" });
		void deleteConversation(target, id)
			.then((removed) => {
				if (id === conversationIdRef.current) {
					resetChat();
				}
				notify(
					removed ? "Conversation deleted" : "Conversation was already absent",
					"info"
				);
			})
			.catch((err) =>
				notify(tf("delete failed: {0}", { 0: errText(err) }), "error")
			);
	}, [overlay, notify, resetChat, target]);

	// Alt+1..3 on an empty chat with an empty composer resumes the listed
	// recent conversation; anywhere else the keys fall through untouched. When
	// the pane holds several tabs the shell's Alt+1..9 tab jump owns them.
	const recentResumeIndex = (key: KeyEvent): number | null => {
		if (!(key.meta || key.option) || key.ctrl || paneHasManyTabs) {
			return null;
		}
		const index = Number.parseInt(key.name, 10) - 1;
		if (
			Number.isNaN(index) ||
			index < 0 ||
			index >= Math.min(recentRows.length, visibleRecentCount) ||
			messages.length > 0 ||
			composer.length > 0
		) {
			return null;
		}
		return index;
	};
	const resumeRecent = (index: number | null): boolean => {
		const row = index === null ? undefined : recentRows[index];
		if (!row) {
			return false;
		}
		runResume(row.id);
		return true;
	};

	// Up/Down walk prompt history only from the top or bottom visual row of the
	// draft, so the arrows still move the cursor through wrapped and multi-line
	// text in the middle of it.
	const historyKeyAllowed = (key: KeyEvent): boolean => {
		if (key.name !== "up" && key.name !== "down") {
			return false;
		}
		if (key.ctrl || key.meta || key.shift || key.super) {
			return false;
		}
		const editor = composerInputRef.current;
		if (!editor || editor.plainText === "") {
			return true;
		}
		const row = editor.scrollY + editor.visualCursor.visualRow;
		const lastRow = Math.max(
			0,
			editor.editorView.getTotalVirtualLineCount() - 1
		);
		return key.name === "up" ? row === 0 : row === lastRow;
	};

	const handleComposerPaste = (event: PasteEvent) => {
		const editor = composerInputRef.current;
		if (!editor) {
			return;
		}
		event.preventDefault();
		const text = normalizePastedText(
			stripAnsiSequences(decodePasteBytes(event.bytes))
		);
		if (!shouldCollapsePaste(text)) {
			editor.insertText(text);
			return;
		}
		pasteSequenceRef.current += 1;
		const token = pastePlaceholderToken(text, pasteSequenceRef.current);
		pastedTextRef.current.set(token, text);
		editor.insertText(token);
	};

	const handleComposeKey = (key: KeyEvent) => {
		if (queueFocused) {
			return;
		}
		if (autocomplete) {
			if (key.name === "escape") {
				setAutocomplete(null);
				return;
			}
			if (
				key.name === "up" ||
				key.name === "down" ||
				(key.ctrl && key.name === "j")
			) {
				// The arrows (and Ctrl+J) belong to the suggestion list, not the
				// editor cursor or its newline binding.
				key.preventDefault();
			}
			if (key.name === "up" || key.name === "k") {
				setAutocomplete((state) =>
					state
						? {
								...state,
								index: moveAutocompleteIndex(
									state.index,
									-1,
									state.suggestions.length
								),
							}
						: null
				);
				return;
			}
			if (key.name === "down" || key.name === "j") {
				setAutocomplete((state) =>
					state
						? {
								...state,
								index: moveAutocompleteIndex(
									state.index,
									1,
									state.suggestions.length
								),
							}
						: null
				);
				return;
			}
			if (
				key.name === "return" &&
				runsOnEnter(
					composerInputRef.current?.plainText ?? composer,
					autocomplete.suggestions[autocomplete.index]
				)
			) {
				// A bare no-argument built-in (`/new`) runs on the first Enter;
				// Tab still completes it.
				key.preventDefault();
				submitComposer();
				return;
			}
			if (
				(key.name === "tab" || key.name === "return") &&
				applySelectedAutocomplete()
			) {
				// Stop the textarea from also submitting (or inserting a newline).
				key.preventDefault();
				return;
			}
		}
		if (key.ctrl && key.name === "q" && queuedMessages.length > 0) {
			setQueueFocused(true);
			setQueueSelectedIndex(0);
		} else if (key.ctrl && key.name === "a") {
			openAgentPicker();
		} else if (key.ctrl && key.name === "r") {
			if (simpleInterface) {
				notify(
					"Model and approval controls are available in Agent or OS.",
					"info"
				);
			} else {
				openAcpPicker();
			}
		} else if (key.ctrl && key.name === "l") {
			resetChat();
		} else if (key.ctrl && key.name === "o") {
			setExpandPrompts((value) => !value);
		} else if (resumeRecent(recentResumeIndex(key))) {
			// Resumed a recent conversation from the empty state.
		} else if (historyKeyAllowed(key)) {
			// Enter is the textarea's own submit binding; only history lives here.
			key.preventDefault();
			const draft = composerRef.current;
			updatePromptHistory((state) => {
				const next =
					key.name === "up"
						? previousPrompt(state, draft)
						: nextPrompt(state, draft);
				setComposerText(next.value);
				return next.state;
			});
		} else if (key.name === "escape" && streaming) {
			interruptTurn();
		} else if (
			key.name === "escape" &&
			queuePaused &&
			queuedMessages.length > 0
		) {
			clearQueuedMessages();
		}
	};

	// Esc mid-turn: stop the turn on Core, keep the partial reply, mark it
	// interrupted, and pause any queued prompts instead of auto-dispatching the
	// next one. The flag is set directly because updateTurnAssistant drops
	// writes once the turn aborts.
	function interruptTurn() {
		setMessages((previous) =>
			previous.map((message, index) =>
				index === previous.length - 1 && message.role === "assistant"
					? { ...message, interrupted: true }
					: message
			)
		);
		if (queuedMessages.length > 0) {
			setQueuePaused(true);
		}
		const stopped = cancelActiveTurn();
		if (!stopped) {
			// A second Esc while a Stop still waits for Core must not end the
			// wait early; that Stop clears `streaming` itself.
			if (!pendingStopRef.current) {
				setStreaming(false);
				clearTurnActivity();
			}
			return;
		}
		clearTurnActivity();
		// Stay busy until Core has answered the cancel: a prompt sent or
		// dequeued before then would start a turn on this conversation that the
		// late cancel could stop instead. Prompts entered meanwhile are queued.
		pendingStopRef.current = stopped;
		stopped.then(() => {
			if (pendingStopRef.current === stopped) {
				pendingStopRef.current = null;
			}
			if (abortRef.current === null) {
				setStreaming(false);
			}
		});
	}

	// Keyboard gated on being the focused pane's active tab.
	useKeyboard((key) => {
		if (!focused || shellKeyboardCaptured || externalOverlayId) {
			return;
		}
		if (overlay.kind === "queue" || queueFocused) {
			return;
		}
		if (overlay.kind === "agents") {
			handleAgentKey(key);
			return;
		}
		if (overlay.kind === "teams") {
			handleTeamKey(key);
			return;
		}
		if (overlay.kind === "models") {
			handleModelKey(key);
			return;
		}
		if (overlay.kind === "acp") {
			handleAcpKey(key);
			return;
		}
		if (overlay.kind === "permission") {
			handlePermissionKey(key);
			return;
		}
		if (overlay.kind === "question") {
			handleQuestionKey(key);
			return;
		}
		if (overlay.kind === "delete") {
			if (key.name === "escape" || key.name === "n") {
				setOverlay({ kind: "none" });
			} else if (key.name === "return" || key.name === "y") {
				void confirmDelete();
			}
			return;
		}
		if (overlay.kind === "help") {
			if (key.name === "escape" || key.name === "return") {
				setOverlay({ kind: "none" });
			}
			return;
		}
		if (overlay.kind === "theme") {
			return;
		}
		if (overlay.kind !== "none") {
			if (
				key.name === "escape" ||
				key.name === "return" ||
				key.name === "space"
			) {
				setOverlay({ kind: "none" });
			}
			return;
		}
		// Transcript scrolling never conflicts with text entry, so it works while
		// the composer is focused. Plain Home/End stay with the input.
		const scrollKind = transcriptScrollForKey(key);
		if (scrollKind && messages.length > 0) {
			// The composer must not also act: an option-reported Ctrl+Alt+U
			// matches its Ctrl+U (delete to line start) binding.
			key.preventDefault();
			transcriptScroll.scroll(scrollKind);
			return;
		}
		handleComposeKey(key);
	});
	return { handleComposerPaste, interruptTurn };
}
