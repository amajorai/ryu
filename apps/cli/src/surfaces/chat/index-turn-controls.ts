// Chat turn controls: input focus claim, stop/reset, stream options, and
// Herdr/chat-activity reporting for the focused chat.

import { useCallback, useEffect } from "react";
import { resolveWorkflowMention } from "../../core/autocomplete.ts";
import { chatActivity } from "../../core/chatActivity.ts";
import { type ChatStreamOptions, stopChatTurn } from "../../core/chatStream.ts";
import { herdrReporter } from "../../core/herdr.ts";
import { readMemoryConsent } from "../../core/memoryConsent.ts";
import { resetPromptNavigation } from "../../core/promptHistory.ts";
import { nextStarterPlaceholder } from "./index-constants.ts";
import type { ChatSurfaceContext } from "./index-context.ts";

type UseChatTurnControlsDeps = Pick<
	ChatSurfaceContext,
	| "abortRef"
	| "acpConfig"
	| "acpMode"
	| "acpModel"
	| "activeToolsRef"
	| "configuredModel"
	| "conversationIdRef"
	| "conversationTitle"
	| "doubleCheckOn"
	| "externalOverlayId"
	| "focused"
	| "herdrId"
	| "messages"
	| "notify"
	| "overlay"
	| "pastedTextRef"
	| "queueFocused"
	| "resumeRequestSequence"
	| "routeAgent"
	| "selectedAgent"
	| "selectedHumanMentionsRef"
	| "selectedTeam"
	| "setActiveTool"
	| "setAdvertisedAcpCommands"
	| "setAutocomplete"
	| "setComposerText"
	| "setConversationTitle"
	| "setDismissedSlashArgumentValue"
	| "setInputFocused"
	| "setMessages"
	| "setOverlay"
	| "setQueuePaused"
	| "setQueuedMessages"
	| "setStarterPlaceholder"
	| "setStreamStartedAt"
	| "setStreaming"
	| "setTurnError"
	| "shellKeyboardCaptured"
	| "simpleInterface"
	| "streaming"
	| "target"
	| "turnConversationRef"
	| "turnError"
	| "updatePromptHistory"
	| "workflowsRef"
>;

export function useChatTurnControls(deps: UseChatTurnControlsDeps) {
	const {
		abortRef,
		acpConfig,
		acpMode,
		acpModel,
		activeToolsRef,
		configuredModel,
		conversationIdRef,
		conversationTitle,
		doubleCheckOn,
		externalOverlayId,
		focused,
		herdrId,
		messages,
		notify,
		overlay,
		pastedTextRef,
		queueFocused,
		resumeRequestSequence,
		routeAgent,
		selectedAgent,
		selectedHumanMentionsRef,
		selectedTeam,
		setActiveTool,
		setAdvertisedAcpCommands,
		setAutocomplete,
		setComposerText,
		setConversationTitle,
		setDismissedSlashArgumentValue,
		setInputFocused,
		setMessages,
		setOverlay,
		setQueuePaused,
		setQueuedMessages,
		setStarterPlaceholder,
		setStreamStartedAt,
		setStreaming,
		setTurnError,
		shellKeyboardCaptured,
		simpleInterface,
		streaming,
		target,
		turnConversationRef,
		turnError,
		updatePromptHistory,
		workflowsRef,
	} = deps;
	// Claim raw input while focused so shell plain-key globals (the bare "?"
	// shortcuts key) stay quiet, including while a chat-local overlay such as a
	// free-text question answer owns typing.
	useEffect(() => {
		setInputFocused(
			focused && !queueFocused && !shellKeyboardCaptured && !externalOverlayId
		);
		return () => setInputFocused(false);
	}, [
		externalOverlayId,
		focused,
		shellKeyboardCaptured,
		queueFocused,
		setInputFocused,
	]);

	// Stop the in-flight turn: abort the local read and cancel the turn on Core,
	// which otherwise keeps generating a persisted turn (and any goal or
	// auto-continue loop) after the client stops reading. Resolves once Core has
	// answered; `null` when no turn is in flight.
	const cancelActiveTurn = useCallback((): Promise<void> | null => {
		const controller = abortRef.current;
		if (!controller) {
			return null;
		}
		abortRef.current = null;
		return stopChatTurn(target, turnConversationRef.current, controller);
	}, [target]);

	const clearTurnActivity = useCallback(() => {
		activeToolsRef.current.clear();
		setActiveTool(null);
		setStreamStartedAt(null);
	}, []);

	const resetChat = useCallback(() => {
		resumeRequestSequence.current += 1;
		// The new chat gets a new conversation id, so its first turn cannot be
		// hit by this cancel; no need to wait for it.
		cancelActiveTurn();
		conversationIdRef.current = crypto.randomUUID();
		setConversationTitle(null);
		setTurnError(null);
		setMessages([]);
		setComposerText("");
		pastedTextRef.current.clear();
		updatePromptHistory(resetPromptNavigation);
		setQueuedMessages([]);
		setQueuePaused(false);
		setStreaming(false);
		clearTurnActivity();
		setOverlay({ kind: "none" });
		setAutocomplete(null);
		setAdvertisedAcpCommands({});
		setDismissedSlashArgumentValue(null);
		setStarterPlaceholder(nextStarterPlaceholder());
		selectedHumanMentionsRef.current = [];
		notify("Started a new chat", "info");
	}, [
		cancelActiveTurn,
		notify,
		clearTurnActivity,
		setComposerText,
		updatePromptHistory,
	]);

	const buildOptions = useCallback((): ChatStreamOptions => {
		const conversationId = conversationIdRef.current;
		const enableLongTerm = readMemoryConsent();
		// Arm Core's double-check turn-hook for this turn when the toggle is on.
		const pluginFlags = doubleCheckOn
			? { "io.ryu.double-check": true }
			: undefined;
		if (simpleInterface) {
			return {
				conversationId,
				enableLongTerm,
				agentId: "ryu",
				pluginFlags,
			};
		}
		if (selectedTeam) {
			return {
				conversationId,
				enableLongTerm,
				teamId: selectedTeam,
				acpModel: acpModel ?? undefined,
				acpMode: acpMode ?? undefined,
				acpConfig,
				pluginFlags,
			};
		}
		return {
			conversationId,
			enableLongTerm,
			agentId: selectedAgent ?? undefined,
			acpModel: acpModel ?? undefined,
			acpMode: acpMode ?? undefined,
			acpConfig,
			pluginFlags,
		};
	}, [
		selectedTeam,
		selectedAgent,
		acpModel,
		acpMode,
		acpConfig,
		doubleCheckOn,
		simpleInterface,
	]);

	const buildOptionsForPrompt = useCallback(
		(text: string): ChatStreamOptions => {
			const options = buildOptions();
			if (simpleInterface) {
				return options;
			}
			const workflowId = resolveWorkflowMention(text, workflowsRef.current);
			return workflowId ? { ...options, workflowId } : options;
		},
		[buildOptions, simpleInterface]
	);

	useEffect(() => {
		const blocked =
			overlay.kind === "permission" || overlay.kind === "question";
		herdrReporter?.update(
			herdrId.current,
			{
				focused,
				state: blocked
					? "blocked"
					: streaming
						? "working"
						: turnError
							? "blocked"
							: "idle",
				message: blocked
					? overlay.kind === "permission"
						? "Waiting for tool permission"
						: "Waiting for an answer"
					: (turnError ?? undefined),
				options: messages.length > 0 ? buildOptions() : undefined,
			},
			target.url
		);
	});
	useEffect(() => {
		const id = herdrId.current;
		return () => herdrReporter?.remove(id);
	}, []);

	const activityModel = simpleInterface
		? null
		: (acpModel ??
			(configuredModel?.agentId === routeAgent ? configuredModel.model : null));
	useEffect(() => {
		chatActivity.update(herdrId.current, {
			focused,
			streaming,
			title: conversationTitle,
			model: activityModel,
		});
	}, [focused, streaming, conversationTitle, activityModel]);
	useEffect(() => {
		const id = herdrId.current;
		return () => chatActivity.remove(id);
	}, []);

	const pushPluginNote = useCallback((text: string) => {
		setOverlay((o) =>
			o.kind === "plugin_note"
				? { kind: "plugin_note", notes: [...o.notes, text] }
				: { kind: "plugin_note", notes: [text] }
		);
	}, []);
	return {
		buildOptions,
		buildOptionsForPrompt,
		cancelActiveTurn,
		clearTurnActivity,
		pushPluginNote,
		resetChat,
	};
}
