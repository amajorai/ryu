// Chat composer submit, autocomplete acceptance and palette chat intents.

import { useCallback, useEffect } from "react";
import { applyAutocomplete } from "../../core/autocomplete.ts";
import { enqueueChatTurn } from "../../core/chatQueue.ts";
import { expandPastePlaceholders } from "../../core/composerPaste.ts";
import {
	historyEntryFor,
	recordPrompt,
	saveSealedPromptHistory,
} from "../../core/promptHistory.ts";
import { tf } from "../../i18n/translate.ts";
import type { ChatSurfaceContext } from "./index-context.ts";

type UseChatSubmitDeps = Pick<
	ChatSurfaceContext,
	| "active"
	| "autocomplete"
	| "buildOptionsForPrompt"
	| "chatIntent"
	| "clearChatIntent"
	| "composer"
	| "composerInputRef"
	| "composerRef"
	| "handleCommand"
	| "historyLoadedUrlRef"
	| "historySealer"
	| "historyTargetUrl"
	| "notify"
	| "notifySelectedHumanMentions"
	| "pastedTextRef"
	| "queuePaused"
	| "queuedMessages"
	| "reloadContributions"
	| "resetChat"
	| "runSessions"
	| "scrollTranscript"
	| "selectedHumanMentionsRef"
	| "send"
	| "setAutocomplete"
	| "setComposerText"
	| "setDismissedSlashArgumentValue"
	| "setQueuePaused"
	| "setQueuedMessages"
	| "setTurnError"
	| "streaming"
	| "toggleDoubleCheck"
	| "updatePromptHistory"
>;

export function useChatSubmit(deps: UseChatSubmitDeps) {
	const {
		active,
		autocomplete,
		buildOptionsForPrompt,
		chatIntent,
		clearChatIntent,
		composer,
		composerInputRef,
		composerRef,
		handleCommand,
		historyLoadedUrlRef,
		historySealer,
		historyTargetUrl,
		notify,
		notifySelectedHumanMentions,
		pastedTextRef,
		queuePaused,
		queuedMessages,
		reloadContributions,
		resetChat,
		runSessions,
		scrollTranscript,
		selectedHumanMentionsRef,
		send,
		setAutocomplete,
		setComposerText,
		setDismissedSlashArgumentValue,
		setQueuePaused,
		setQueuedMessages,
		setTurnError,
		streaming,
		toggleDoubleCheck,
		updatePromptHistory,
	} = deps;
	const submitComposer = useCallback(() => {
		// Read the editor buffer directly: typing and Enter can land in one
		// batch before the content-change event has updated the ref.
		const draft = composerInputRef.current?.plainText ?? composerRef.current;
		const text = expandPastePlaceholders(draft, pastedTextRef.current);
		// Enter on an empty composer resumes a paused queue: the drain effect
		// then sends the oldest queued prompt.
		if (
			text.trim() === "" &&
			!streaming &&
			queuePaused &&
			queuedMessages.length > 0
		) {
			setQueuePaused(false);
			return;
		}
		// Nothing to send (e.g. a stray second Enter after a command ran).
		if (text.trim() === "") {
			return;
		}
		setTurnError(null);
		setComposerText("");
		pastedTextRef.current.clear();
		setAutocomplete(null);
		updatePromptHistory((state) => {
			// The composer text, not the expanded prompt: collapsed pastes and
			// slash-command arguments are never recorded.
			const next = recordPrompt(state, historyEntryFor(draft));
			if (historySealer && historyLoadedUrlRef.current === historyTargetUrl) {
				saveSealedPromptHistory(next.entries, historySealer).catch(() => {
					// Best-effort; the history stays in memory.
				});
			}
			return next;
		});
		if (handleCommand(text)) {
			selectedHumanMentionsRef.current = [];
			return;
		}
		if (streaming) {
			const result = enqueueChatTurn(
				queuedMessages,
				text,
				buildOptionsForPrompt(text)
			);
			if (result.accepted) {
				setQueuedMessages(result.queue);
				notify(
					tf("Queued prompt ({length})", { length: result.queue.length }),
					"info"
				);
				notifySelectedHumanMentions(text);
			} else {
				selectedHumanMentionsRef.current = [];
				notify(
					"Prompt queue is full (50); wait for the current turn",
					"warning"
				);
			}
			return;
		}
		// A typed prompt goes first ("send now"); the paused queue drains after.
		setQueuePaused(false);
		// Sending is a request to follow the new turn: leave any scrolled-back
		// position so the prompt and its reply are not hidden behind the strip.
		scrollTranscript("bottom");
		send(text, buildOptionsForPrompt(text));
		notifySelectedHumanMentions(text);
	}, [
		handleCommand,
		queuePaused,
		queuedMessages,
		streaming,
		send,
		notify,
		buildOptionsForPrompt,
		notifySelectedHumanMentions,
		historySealer,
		historyTargetUrl,
		scrollTranscript,
		setComposerText,
		updatePromptHistory,
	]);

	const applySelectedAutocomplete = useCallback(() => {
		if (!autocomplete) {
			return false;
		}
		const suggestion = autocomplete.suggestions[autocomplete.index];
		if (!suggestion) {
			return false;
		}
		if (suggestion.kind === "retry-slash-commands") {
			setAutocomplete(null);
			reloadContributions();
			return true;
		}
		if (
			suggestion.kind === "human" &&
			!selectedHumanMentionsRef.current.some(
				(mention) => mention.id === suggestion.id
			)
		) {
			selectedHumanMentionsRef.current.push({
				id: suggestion.id,
				label: suggestion.name,
			});
		}
		const nextComposer = applyAutocomplete(
			composer,
			autocomplete.context,
			suggestion
		);
		setDismissedSlashArgumentValue(
			autocomplete.context.kind === "slash-argument" &&
				suggestion.kind === "slash-argument-option" &&
				!autocomplete.context.hasNextArgument
				? nextComposer
				: null
		);
		setComposerText(nextComposer);
		setAutocomplete(null);
		return true;
	}, [autocomplete, composer, reloadContributions, setComposerText]);

	// Apply a palette-issued chat intent once this surface is the active tab.
	useEffect(() => {
		if (!(active && chatIntent)) {
			return;
		}
		if (chatIntent === "new") {
			resetChat();
		} else if (chatIntent === "sessions") {
			runSessions();
		} else if (chatIntent === "toggle-check") {
			toggleDoubleCheck();
		}
		clearChatIntent();
	}, [
		active,
		chatIntent,
		clearChatIntent,
		resetChat,
		runSessions,
		toggleDoubleCheck,
	]);
	return { applySelectedAutocomplete, submitComposer };
}
