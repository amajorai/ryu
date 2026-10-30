// Chat pickers and conversation commands: agent/group/ACP/model pickers,
// /btw, /sessions, /fork, /pin, /resume, /rename, /delete and double-check.

import { fetchAcpConfig } from "@ryuhq/core-client/acp";
import { fetchAgents } from "@ryuhq/core-client/agents";
import { askBtw } from "@ryuhq/core-client/btw";
import { listSessionsForConversation } from "@ryuhq/core-client/sessions";
import { fetchTeams } from "@ryuhq/core-client/teams";
import { useCallback, useEffect, useRef } from "react";
import { acpPickerChoices } from "../../core/acpPicker.ts";
import {
	forkConversation,
	renameConversation,
	resumeConversation,
	setConversationPinned,
} from "../../core/conversations.ts";
import {
	acpModelPickerChoices,
	agentModelPickerChoices,
	type ModelPickerChoice,
	withDefaultModelChoice,
} from "../../core/modelPicker.ts";
import { nativeErrorMessage as errText } from "../../core/native-errors.ts";
import { tf } from "../../i18n/translate.ts";
import {
	BOT_ROUTING_NOTICE,
	resumedChatParts,
	takeMessageId,
} from "./index-constants.ts";
import type { ChatSurfaceContext } from "./index-context.ts";

type UseChatRunnersDeps = Pick<
	ChatSurfaceContext,
	| "conversationIdRef"
	| "doubleCheckOn"
	| "latestResumeIdentity"
	| "notify"
	| "resumeIdentity"
	| "resumeRequestSequence"
	| "selectedAgent"
	| "selectedTeam"
	| "setConversationTitle"
	| "setDoubleCheckOn"
	| "setMessages"
	| "setOverlay"
	| "setQueuedMessages"
	| "setSelectedAgent"
	| "setSelectedTeam"
	| "setTurnError"
	| "simpleInterface"
	| "startupResume"
	| "streaming"
	| "target"
	| "teamPickerRequestRef"
>;

export function useChatRunners(deps: UseChatRunnersDeps) {
	const {
		conversationIdRef,
		doubleCheckOn,
		latestResumeIdentity,
		notify,
		resumeIdentity,
		resumeRequestSequence,
		selectedAgent,
		selectedTeam,
		setConversationTitle,
		setDoubleCheckOn,
		setMessages,
		setOverlay,
		setQueuedMessages,
		setSelectedAgent,
		setSelectedTeam,
		setTurnError,
		simpleInterface,
		startupResume,
		streaming,
		target,
		teamPickerRequestRef,
	} = deps;
	const openAgentPicker = useCallback(() => {
		if (simpleInterface) {
			notify(BOT_ROUTING_NOTICE, "info");
			return;
		}
		fetchAgents(target)
			.then((agents) =>
				setOverlay({
					kind: "agents",
					agents: agents.map((a) => ({ id: a.id, name: a.name })),
					index: 0,
				})
			)
			.catch((err) =>
				notify(tf("agents failed: {0}", { 0: errText(err) }), "error")
			);
	}, [notify, simpleInterface, target]);

	const loadTeams = useCallback(
		(requestId: number) => {
			fetchTeams(target)
				.then((teams) => {
					if (teamPickerRequestRef.current !== requestId) {
						return;
					}
					setOverlay((current) =>
						current.kind === "teams"
							? { ...current, teams, index: 0, loading: false, error: null }
							: current
					);
				})
				.catch((err) => {
					if (teamPickerRequestRef.current !== requestId) {
						return;
					}
					setOverlay((current) =>
						current.kind === "teams"
							? { ...current, loading: false, error: errText(err) }
							: current
					);
				});
		},
		[target]
	);

	const openTeamPicker = useCallback(() => {
		if (simpleInterface) {
			notify(BOT_ROUTING_NOTICE, "info");
			return;
		}
		const requestId = ++teamPickerRequestRef.current;
		setOverlay({
			kind: "teams",
			teams: [],
			index: 0,
			loading: true,
			error: null,
		});
		loadTeams(requestId);
	}, [loadTeams, notify, simpleInterface]);

	const openAcpPicker = useCallback(() => {
		if (!selectedAgent || selectedTeam) {
			notify("Choose an agent before opening ACP settings", "warning");
			return;
		}
		fetchAcpConfig(target, selectedAgent)
			.then((config) => {
				const choices = acpPickerChoices(config);
				if (choices.length === 0) {
					notify(
						"This agent exposes no permission or reasoning settings",
						"info"
					);
					return;
				}
				setOverlay({ kind: "acp", choices, index: 0 });
			})
			.catch((err) =>
				notify(tf("ACP settings failed: {0}", { 0: errText(err) }), "error")
			);
	}, [selectedAgent, selectedTeam, target, notify]);

	const openModelPicker = useCallback(() => {
		fetchAgents(target)
			.then(async (agents) => {
				let choices: ModelPickerChoice[] = [];
				if (selectedAgent && !selectedTeam) {
					try {
						choices = acpModelPickerChoices(
							await fetchAcpConfig(target, selectedAgent)
						);
					} catch {
						// Fall back to the model already configured on the agent.
						choices = [];
					}
				}
				if (choices.length === 0) {
					choices = agentModelPickerChoices(agents, selectedAgent);
				}
				if (choices.length === 0) {
					notify("No models are available for the current agent", "info");
					return;
				}
				setOverlay({
					kind: "models",
					choices: withDefaultModelChoice(choices),
					index: 0,
				});
			})
			.catch((err) =>
				notify(tf("models failed: {0}", { 0: errText(err) }), "error")
			);
	}, [selectedAgent, selectedTeam, target, notify]);

	const runBtw = useCallback(
		(arg: string) => {
			if (arg.length === 0) {
				notify("usage: /btw <question>", "warning");
				return;
			}
			setOverlay({ kind: "btw", question: arg, answer: null });
			askBtw(target, conversationIdRef.current, arg)
				.then((res) =>
					setOverlay({ kind: "btw", question: arg, answer: res.answer })
				)
				.catch((err) => {
					setOverlay({ kind: "none" });
					notify(tf("btw failed: {0}", { 0: errText(err) }), "error");
				});
		},
		[target, notify]
	);

	const runTeam = useCallback(
		(arg: string) => {
			if (simpleInterface) {
				notify(BOT_ROUTING_NOTICE, "info");
				return;
			}
			if (arg.length === 0 || arg === "clear") {
				setSelectedTeam(null);
				notify("Group routing cleared", "info");
				return;
			}
			setSelectedTeam(arg);
			setSelectedAgent(null);
			notify(`Group: ${arg}`, "info");
		},
		[notify, simpleInterface]
	);

	const runSessions = useCallback(() => {
		listSessionsForConversation(target, conversationIdRef.current)
			.then((sessions) => setOverlay({ kind: "sessions", sessions }))
			.catch((err) =>
				notify(tf("sessions failed: {0}", { 0: errText(err) }), "error")
			);
	}, [target, notify]);

	const runFork = useCallback(
		(messageId: string) => {
			if (streaming) {
				notify("Wait for the current turn to finish before forking", "warning");
				return;
			}
			forkConversation(
				target,
				conversationIdRef.current,
				messageId.length > 0 ? messageId : undefined
			)
				.then((newConversationId) => {
					conversationIdRef.current = newConversationId;
					setConversationTitle(null);
					setTurnError(null);
					setMessages([]);
					setQueuedMessages([]);
					notify(
						tf("Forked chat: {newConversationId}", { newConversationId }),
						"info"
					);
				})
				.catch((err) =>
					notify(tf("fork failed: {0}", { 0: errText(err) }), "error")
				);
		},
		[target, notify, streaming]
	);

	const runPin = useCallback(
		(pinned: boolean) => {
			setConversationPinned(target, conversationIdRef.current, pinned)
				.then(() => notify(pinned ? "Chat pinned" : "Chat unpinned", "info"))
				.catch((err) =>
					notify(`${pinned ? "pin" : "unpin"} failed: ${errText(err)}`, "error")
				);
		},
		[target, notify]
	);

	const runResume = useCallback(
		(conversationId: string) => {
			if (conversationId.length === 0) {
				notify("usage: /resume <conversation-id>", "warning");
				return;
			}
			if (streaming) {
				notify(
					"Wait for the current turn to finish before resuming",
					"warning"
				);
				return;
			}
			const requestSequence = ++resumeRequestSequence.current;
			const sourceConversationId = conversationIdRef.current;
			const isCurrentResume = () =>
				requestSequence === resumeRequestSequence.current &&
				resumeIdentity === latestResumeIdentity.current &&
				sourceConversationId === conversationIdRef.current;
			resumeConversation(target, conversationId)
				.then((conversation) => {
					if (!isCurrentResume()) {
						return;
					}
					conversationIdRef.current = conversation.id;
					setConversationTitle(conversation.title || null);
					setTurnError(null);
					setMessages(
						conversation.messages.map((message) => ({
							id: takeMessageId(),
							role: message.role === "user" ? "user" : "assistant",
							content: message.content,
							parts: resumedChatParts(message),
						}))
					);
					setQueuedMessages([]);
					setOverlay({ kind: "none" });
					notify(
						conversation.title
							? `Resumed: ${conversation.title}`
							: tf("Resumed chat: {id}", { id: conversation.id }),
						"info"
					);
				})
				.catch((err) => {
					if (isCurrentResume()) {
						notify(tf("resume failed: {0}", { 0: errText(err) }), "error");
					}
				});
		},
		[target, notify, streaming, resumeIdentity]
	);

	const startupApplied = useRef(false);
	useEffect(() => {
		if (startupResume && !startupApplied.current) {
			startupApplied.current = true;
			runResume(startupResume.id);
		}
	}, [runResume, startupResume]);

	const runRename = useCallback(
		(title: string) => {
			if (title.length === 0) {
				notify("usage: /rename <title>", "warning");
				return;
			}
			const conversationId = conversationIdRef.current;
			renameConversation(target, conversationId, title)
				.then((nextTitle) => {
					if (conversationIdRef.current === conversationId) {
						setConversationTitle(nextTitle);
					}
					notify(`Renamed: ${nextTitle}`, "info");
				})
				.catch((err) =>
					notify(tf("rename failed: {0}", { 0: errText(err) }), "error")
				);
		},
		[target, notify]
	);

	const runDelete = useCallback((conversationId: string) => {
		const id = conversationId || conversationIdRef.current;
		setOverlay({ kind: "delete", conversationId: id });
	}, []);

	const toggleDoubleCheck = useCallback(() => {
		setDoubleCheckOn(!doubleCheckOn);
		notify(doubleCheckOn ? "Double-check off" : "Double-check armed", "info");
	}, [doubleCheckOn, notify]);
	return {
		loadTeams,
		openAcpPicker,
		openAgentPicker,
		openModelPicker,
		openTeamPicker,
		runBtw,
		runDelete,
		runFork,
		runPin,
		runRename,
		runResume,
		runSessions,
		runTeam,
		toggleDoubleCheck,
	};
}
