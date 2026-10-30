// Chat overlay key handlers: agent, group, model and ACP pickers, tool
// permission prompts and agent questions.

import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useRef } from "react";
import { applyAcpPickerChoice } from "../../core/acpPicker.ts";
import {
	type ChatPermission,
	type ChatPermissionOption,
	isRejectPermissionOption,
	permissionToolCallId,
	respondToChatPermission,
} from "../../core/chatPermission.ts";
import {
	type ChatQuestionAnswer,
	respondToChatQuestion,
} from "../../core/chatQuestion.ts";
import { appendToolOutputPart } from "../../core/chatTranscript.ts";
import { nativeErrorMessage as errText } from "../../core/native-errors.ts";
import { tf } from "../../i18n/translate.ts";
import {
	PERMISSION_BODY_PAGE_ROWS,
	PERMISSION_DIGIT,
	PERMISSION_NEXT_KEYS,
	PERMISSION_PREVIOUS_KEYS,
} from "./index-constants.ts";
import type { ChatSurfaceContext } from "./index-context.ts";

type UseChatOverlayKeysDeps = Pick<
	ChatSurfaceContext,
	| "acpConfig"
	| "acpMode"
	| "conversationIdRef"
	| "herdrTurn"
	| "loadTeams"
	| "notify"
	| "overlay"
	| "setAcpConfig"
	| "setAcpMode"
	| "setAcpModel"
	| "setMessages"
	| "setOverlay"
	| "setSelectedAgent"
	| "setSelectedTeam"
	| "target"
	| "teamPickerRequestRef"
>;

export function useChatOverlayKeys(deps: UseChatOverlayKeysDeps) {
	const {
		acpConfig,
		acpMode,
		conversationIdRef,
		herdrTurn,
		loadTeams,
		notify,
		overlay,
		setAcpConfig,
		setAcpMode,
		setAcpModel,
		setMessages,
		setOverlay,
		setSelectedAgent,
		setSelectedTeam,
		target,
		teamPickerRequestRef,
	} = deps;
	const handleAgentKey = (key: KeyEvent) => {
		if (overlay.kind !== "agents") {
			return;
		}
		if (key.name === "escape") {
			setOverlay({ kind: "none" });
		} else if (key.name === "up" || key.name === "k") {
			setOverlay((o) =>
				o.kind === "agents" ? { ...o, index: Math.max(0, o.index - 1) } : o
			);
		} else if (key.name === "down" || key.name === "j") {
			setOverlay((o) =>
				o.kind === "agents"
					? { ...o, index: Math.min(o.agents.length - 1, o.index + 1) }
					: o
			);
		} else if (key.name === "return") {
			const chosen = overlay.agents[overlay.index];
			if (chosen) {
				setSelectedAgent(chosen.id);
				setSelectedTeam(null);
				notify(`Agent: ${chosen.name}`, "info");
			}
			setOverlay({ kind: "none" });
		}
	};

	const handleTeamKey = (key: KeyEvent) => {
		if (overlay.kind !== "teams") {
			return;
		}
		if (key.name === "escape") {
			teamPickerRequestRef.current += 1;
			setOverlay({ kind: "none" });
			return;
		}
		if (overlay.loading) {
			return;
		}
		if (overlay.error) {
			if (key.name === "r") {
				const requestId = ++teamPickerRequestRef.current;
				setOverlay((current) =>
					current.kind === "teams"
						? { ...current, loading: true, error: null }
						: current
				);
				loadTeams(requestId);
			}
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setOverlay((current) =>
				current.kind === "teams"
					? { ...current, index: Math.max(0, current.index - 1) }
					: current
			);
		} else if (key.name === "down" || key.name === "j") {
			setOverlay((current) =>
				current.kind === "teams"
					? {
							...current,
							index: Math.min(current.teams.length - 1, current.index + 1),
						}
					: current
			);
		} else if (key.name === "return") {
			const selected = overlay.teams[overlay.index];
			if (selected) {
				setSelectedTeam(selected.id);
				setSelectedAgent(null);
				notify(`Group: ${selected.name}`, "info");
			}
			setOverlay({ kind: "none" });
		}
	};

	const handleModelKey = (key: KeyEvent) => {
		if (overlay.kind !== "models") {
			return;
		}
		if (key.name === "escape") {
			setOverlay({ kind: "none" });
		} else if (key.name === "up" || key.name === "k") {
			setOverlay((o) =>
				o.kind === "models" ? { ...o, index: Math.max(0, o.index - 1) } : o
			);
		} else if (key.name === "down" || key.name === "j") {
			setOverlay((o) =>
				o.kind === "models"
					? { ...o, index: Math.min(o.choices.length - 1, o.index + 1) }
					: o
			);
		} else if (key.name === "return") {
			const choice = overlay.choices[overlay.index];
			if (choice) {
				setAcpModel(choice.id);
				notify(
					choice.id ? `Model: ${choice.label}` : "Model override cleared",
					"info"
				);
			}
			setOverlay({ kind: "none" });
		}
	};

	const handleAcpKey = (key: KeyEvent) => {
		if (overlay.kind !== "acp") {
			return;
		}
		if (key.name === "escape") {
			setOverlay({ kind: "none" });
		} else if (key.name === "up" || key.name === "k") {
			setOverlay((o) =>
				o.kind === "acp" ? { ...o, index: Math.max(0, o.index - 1) } : o
			);
		} else if (key.name === "down" || key.name === "j") {
			setOverlay((o) =>
				o.kind === "acp"
					? { ...o, index: Math.min(o.choices.length - 1, o.index + 1) }
					: o
			);
		} else if (key.name === "return") {
			const choice = overlay.choices[overlay.index];
			if (choice) {
				const next = applyAcpPickerChoice(choice, {
					mode: acpMode,
					config: acpConfig,
				});
				setAcpMode(next.mode);
				setAcpConfig(next.config);
				notify(`ACP: ${choice.label}`, "info");
			}
			setOverlay({ kind: "none" });
		}
	};

	// A rejected permission strikes the tool row through instead of leaving it
	// spinning until the turn ends. Without an ACP toolCallId nothing changes.
	const markPermissionDenied = (toolCall: ChatPermission["toolCall"]) => {
		const toolCallId = permissionToolCallId(toolCall);
		if (!toolCallId) {
			return;
		}
		setMessages((previous) => {
			const index = previous.findLastIndex(
				(message) => message.role === "assistant"
			);
			const message = previous[index];
			if (!message) {
				return previous;
			}
			const parts = appendToolOutputPart(
				message.parts,
				"denied",
				undefined,
				toolCallId
			);
			return parts === message.parts
				? previous
				: previous.with(index, { ...message, parts });
		});
	};

	const submitPermission = (
		permission: ChatPermission,
		option: ChatPermissionOption
	) => {
		const report = herdrTurn.current?.report;
		if (isRejectPermissionOption(option)) {
			markPermissionDenied(permission.toolCall);
		}
		setOverlay({ kind: "none" });
		respondToChatPermission(target, permission.requestId, option.optionId)
			.then((resolved) => {
				if (resolved) {
					report?.("working");
				}
			})
			.catch((err) =>
				notify(tf("permission failed: {0}", { 0: errText(err) }), "error")
			);
	};

	const permissionBodyRef = useRef<ScrollBoxRenderable | null>(null);
	const handlePermissionKey = (key: KeyEvent) => {
		if (overlay.kind !== "permission") {
			return;
		}
		if (key.name === "escape") {
			const report = herdrTurn.current?.report;
			const requestId = overlay.permission.requestId;
			markPermissionDenied(overlay.permission.toolCall);
			setOverlay({ kind: "none" });
			respondToChatPermission(target, requestId, null)
				.then((resolved) => {
					if (resolved) {
						report?.("working");
					}
				})
				.catch((err) =>
					notify(tf("permission rejected: {0}", { 0: errText(err) }), "error")
				);
			return;
		}
		if (PERMISSION_PREVIOUS_KEYS.has(key.name)) {
			setOverlay((o) =>
				o.kind === "permission" ? { ...o, index: Math.max(0, o.index - 1) } : o
			);
			return;
		}
		if (PERMISSION_NEXT_KEYS.has(key.name)) {
			setOverlay((o) =>
				o.kind === "permission"
					? {
							...o,
							index: Math.min(o.permission.options.length - 1, o.index + 1),
						}
					: o
			);
			return;
		}
		if (key.name === "pageup" || key.name === "pagedown") {
			permissionBodyRef.current?.scrollBy(
				key.name === "pageup"
					? -PERMISSION_BODY_PAGE_ROWS
					: PERMISSION_BODY_PAGE_ROWS
			);
			return;
		}
		// 1-9 choose and submit at once; a digit past the last option is ignored.
		const plainDigit =
			!(key.ctrl || key.meta || key.option) && PERMISSION_DIGIT.test(key.name);
		const digit = plainDigit ? Number(key.name) : 0;
		const digitOption = overlay.permission.options[digit - 1];
		if (digit > 0 && digitOption) {
			submitPermission(overlay.permission, digitOption);
			return;
		}
		if (key.name === "return") {
			const option = overlay.permission.options[overlay.index];
			if (option) {
				submitPermission(overlay.permission, option);
			}
		}
	};

	const handleQuestionKey = (key: KeyEvent) => {
		if (overlay.kind !== "question") {
			return;
		}
		const current = overlay.question.questions[overlay.questionIndex];
		if (!current) {
			return;
		}
		if (key.name === "escape") {
			const report = herdrTurn.current?.report;
			setOverlay({ kind: "none" });
			void respondToChatQuestion(
				target,
				conversationIdRef.current,
				overlay.question,
				[{ kind: "skip", question_id: current.id }]
			)
				.then((resolved) => {
					if (resolved) {
						report?.("working");
					}
				})
				.catch((err) =>
					notify(tf("question rejected: {0}", { 0: errText(err) }), "error")
				);
			return;
		}
		if (current.kind === "text") {
			if (key.name === "backspace") {
				setOverlay((state) =>
					state.kind === "question"
						? { ...state, text: state.text.slice(0, -1) }
						: state
				);
				return;
			}
			if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
				setOverlay((state) =>
					state.kind === "question"
						? { ...state, text: state.text + key.sequence }
						: state
				);
				return;
			}
		}
		if (key.name === "up" || key.name === "k") {
			setOverlay((state) =>
				state.kind === "question"
					? { ...state, selected: Math.max(0, state.selected - 1) }
					: state
			);
			return;
		}
		if (key.name === "down" || key.name === "j") {
			setOverlay((state) =>
				state.kind === "question"
					? {
							...state,
							selected: Math.min(
								Math.max(0, current.options.length - 1),
								state.selected + 1
							),
						}
					: state
			);
			return;
		}
		if (key.name !== "return") {
			return;
		}
		const selected = current.options[overlay.selected];
		const answer: ChatQuestionAnswer =
			current.kind === "text"
				? { kind: "text", question_id: current.id, text: overlay.text }
				: {
						kind: current.kind,
						question_id: current.id,
						selected_ids: selected ? [selected.id] : [],
					};
		const answers = [...overlay.answers, answer];
		const nextIndex = overlay.questionIndex + 1;
		if (nextIndex < overlay.question.questions.length) {
			setOverlay({
				...overlay,
				answers,
				questionIndex: nextIndex,
				selected: 0,
				text: "",
			});
			return;
		}
		setOverlay({ kind: "none" });
		const report = herdrTurn.current?.report;
		void respondToChatQuestion(
			target,
			conversationIdRef.current,
			overlay.question,
			answers
		)
			.then((resolved) => {
				if (resolved) {
					report?.("working");
				}
				if (!resolved) {
					notify("Question expired before it was answered", "warning");
				}
			})
			.catch((err) =>
				notify(tf("question failed: {0}", { 0: errText(err) }), "error")
			);
	};
	return {
		handleAcpKey,
		handleAgentKey,
		handleModelKey,
		handlePermissionKey,
		handleQuestionKey,
		handleTeamKey,
		permissionBodyRef,
		submitPermission,
	};
}
