// Chat queue, theme and slash-command dispatch.

import { useCallback } from "react";
import {
	clearChatQueue,
	moveQueuedChatTurn,
	removeQueuedChatTurn,
} from "../../core/chatQueue.ts";
import {
	type CommandAction,
	dispatchCommand,
	isAdvertisedAgentCommand,
	isContributedPluginCommand,
} from "../../core/commands.ts";
import { RYU_THEME_PRESETS } from "../../core/themePreferences.ts";
import { tf } from "../../i18n/translate.ts";
import { BOT_ROUTING_NOTICE } from "./index-constants.ts";
import type { ChatSurfaceContext } from "./index-context.ts";

type UseChatCommandsDeps = Pick<
	ChatSurfaceContext,
	| "activeAcpCommands"
	| "availableModes"
	| "availablePresets"
	| "contributedSlashCommands"
	| "notify"
	| "openAcpPicker"
	| "openAgentPicker"
	| "openModelPicker"
	| "openOverlay"
	| "openTeamPicker"
	| "queueSelectedIndex"
	| "queuedMessages"
	| "resetChat"
	| "runBtw"
	| "runDelete"
	| "runFork"
	| "runPin"
	| "runRename"
	| "runResume"
	| "runSessions"
	| "runTeam"
	| "setAcpModel"
	| "setOverlay"
	| "setQueueFocused"
	| "setQueuePaused"
	| "setQueueSelectedIndex"
	| "setQueuedMessages"
	| "setThemeMode"
	| "setThemePreset"
	| "simpleInterface"
	| "toggleDoubleCheck"
>;

export function useChatCommands(deps: UseChatCommandsDeps) {
	const {
		activeAcpCommands,
		availableModes,
		availablePresets,
		contributedSlashCommands,
		notify,
		openAcpPicker,
		openAgentPicker,
		openModelPicker,
		openOverlay,
		openTeamPicker,
		queueSelectedIndex,
		queuedMessages,
		resetChat,
		runBtw,
		runDelete,
		runFork,
		runPin,
		runRename,
		runResume,
		runSessions,
		runTeam,
		setAcpModel,
		setOverlay,
		setQueueFocused,
		setQueuePaused,
		setQueueSelectedIndex,
		setQueuedMessages,
		setThemeMode,
		setThemePreset,
		simpleInterface,
		toggleDoubleCheck,
	} = deps;
	const clearQueuedMessages = useCallback(() => {
		if (queuedMessages.length === 0) {
			return;
		}
		setQueuedMessages(clearChatQueue(queuedMessages));
		setQueuePaused(false);
		setOverlay({ kind: "none" });
		setQueueFocused(false);
		notify("Queue cleared", "info");
	}, [notify, queuedMessages]);

	const removeQueuedMessageAt = useCallback(
		(index: number) => {
			const turn = queuedMessages[index];
			if (!turn) {
				return;
			}
			setQueuedMessages(removeQueuedChatTurn(queuedMessages, turn.id));
			notify("Removed queued prompt", "info");
		},
		[notify, queuedMessages]
	);

	const moveQueuedMessage = useCallback(
		(id: string, direction: "up" | "down") => {
			setQueuedMessages((current) =>
				moveQueuedChatTurn(current, id, direction)
			);
		},
		[]
	);

	const moveQueuedMessageAt = useCallback(
		(index: number, direction: "up" | "down") => {
			const turn = queuedMessages[index];
			if (!turn) {
				return;
			}
			const nextIndex =
				direction === "up"
					? Math.max(0, index - 1)
					: Math.min(queuedMessages.length - 1, index + 1);
			if (nextIndex === index) {
				return;
			}
			setQueuedMessages((current) =>
				moveQueuedChatTurn(current, turn.id, direction)
			);
			setQueueSelectedIndex(nextIndex);
		},
		[queuedMessages]
	);

	const openQueue = useCallback(
		(index = queueSelectedIndex) => {
			if (queuedMessages.length === 0) {
				notify("The prompt queue is empty", "info");
				return;
			}
			const nextIndex = Math.min(
				Math.max(0, index),
				Math.max(0, queuedMessages.length - 1)
			);
			setQueueSelectedIndex(nextIndex);
			setQueueFocused(false);
			setOverlay({ kind: "queue", index: nextIndex });
		},
		[notify, queueSelectedIndex, queuedMessages.length]
	);

	const openTheme = useCallback(
		(argument = "") => setOverlay({ kind: "theme", argument }),
		[]
	);

	const applyThemeArgument = useCallback(
		(argument: string): boolean => {
			const normalized = argument.trim().toLowerCase();
			if (normalized.length === 0) {
				return false;
			}
			const mode = availableModes.find((candidate) => candidate === normalized);
			if (mode) {
				setThemeMode(mode);
				notify(tf("Theme mode: {normalized}", { normalized }), "info");
				return true;
			}
			const preset = availablePresets.find(
				(candidate) => candidate === normalized
			);
			if (preset) {
				setThemePreset(preset);
				notify(
					tf("Theme preset: {label}", {
						label: RYU_THEME_PRESETS[preset].label,
					}),
					"info"
				);
				return true;
			}
			return false;
		},
		[availableModes, availablePresets, notify, setThemeMode, setThemePreset]
	);

	const applyCommandAction = useCallback(
		(action: CommandAction): boolean => {
			if (action.kind === "passthrough") {
				return false;
			}
			if (
				simpleInterface &&
				((action.kind === "overlay" &&
					(action.overlay === "acp-settings" ||
						action.overlay === "model-picker")) ||
					(action.kind === "local" &&
						(action.action === "set-model" || action.action === "set-team")))
			) {
				if (action.kind === "local" && action.action === "set-team") {
					notify(BOT_ROUTING_NOTICE, "info");
				} else {
					notify(
						"Model and approval controls are available in Agent or OS.",
						"info"
					);
				}
				return true;
			}
			if (action.kind === "overlay") {
				switch (action.overlay) {
					case "agent-picker":
						openAgentPicker();
						return true;
					case "acp-settings":
						openAcpPicker();
						return true;
					case "btw":
						runBtw(action.argument);
						return true;
					case "conversation-delete":
						runDelete(action.argument);
						return true;
					case "help":
						// Bare /help opens the shell's keyboard-shortcuts overlay (keys
						// and every command); /help <command> shows that command's usage.
						if (action.argument) {
							setOverlay({ kind: "help", command: action.argument });
						} else {
							openOverlay("keymap");
						}
						return true;
					case "model-picker":
						openModelPicker();
						return true;
					case "queue":
						openQueue();
						return true;
					case "session-list":
						runSessions();
						return true;
					case "theme":
						if (!applyThemeArgument(action.argument)) {
							openTheme(action.argument);
						}
						return true;
				}
			}
			if (action.kind !== "local") {
				return true;
			}
			switch (action.action) {
				case "new-chat":
					resetChat();
					return true;
				case "toggle-double-check":
					toggleDoubleCheck();
					return true;
				case "set-model":
					setAcpModel(action.model);
					notify(
						action.model ? `Model: ${action.model}` : "Model override cleared",
						"info"
					);
					return true;
				case "set-team":
					runTeam(action.team ?? "");
					return true;
				case "fork-conversation":
					runFork(action.messageId ?? "");
					return true;
				case "resume-conversation":
					runResume(action.conversationId);
					return true;
				case "rename-conversation":
					runRename(action.title);
					return true;
				case "pin-conversation":
					runPin(action.pinned);
					return true;
				case "clear-queue":
					clearQueuedMessages();
					return true;
				case "remove-queue-item": {
					const index = queuedMessages.findIndex(
						(turn) => turn.id === action.itemId
					);
					if (index >= 0) {
						removeQueuedMessageAt(index);
					}
					return true;
				}
				case "move-queue-item":
					moveQueuedMessage(action.itemId, action.direction);
					return true;
			}
		},
		[
			applyThemeArgument,
			clearQueuedMessages,
			simpleInterface,
			moveQueuedMessage,
			notify,
			openAcpPicker,
			openAgentPicker,
			openModelPicker,
			openOverlay,
			openQueue,
			openTheme,
			queuedMessages,
			removeQueuedMessageAt,
			resetChat,
			runBtw,
			runDelete,
			runFork,
			runPin,
			runRename,
			runResume,
			runSessions,
			runTeam,
			setThemeMode,
			toggleDoubleCheck,
		]
	);

	const handleCommand = useCallback(
		(raw: string): boolean => {
			if (/^\/(?:group|team)\s*$/i.test(raw.trim())) {
				openTeamPicker();
				return true;
			}
			const dispatch = dispatchCommand(raw);
			if (!dispatch) {
				return false;
			}
			if (
				dispatch.kind === "unknown" &&
				(isContributedPluginCommand(raw, contributedSlashCommands) ||
					isAdvertisedAgentCommand(raw, activeAcpCommands))
			) {
				return false;
			}
			if (dispatch.kind === "unknown" || dispatch.kind === "usage") {
				notify(dispatch.message, "warning");
				return true;
			}
			return applyCommandAction(dispatch.action);
		},
		[
			activeAcpCommands,
			applyCommandAction,
			contributedSlashCommands,
			notify,
			openTeamPicker,
		]
	);
	return {
		applyCommandAction,
		applyThemeArgument,
		clearQueuedMessages,
		handleCommand,
		moveQueuedMessage,
		moveQueuedMessageAt,
		openQueue,
		openTheme,
		removeQueuedMessageAt,
	};
}
